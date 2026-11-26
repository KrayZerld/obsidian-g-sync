import { TFile, type App, type FileSystemAdapter } from "obsidian";
import { isPathUnderConfigDir, normalizeConfigDir } from "../constants";
import type {
	LocalFileSnapshot,
	LocalVaultPort,
	ScanScopeOptions,
	SyncLogDetail,
} from "../types";
import { computeMd5, normalizeRelativePath, splitDirAndName } from "./HashUtil";

async function tryTrashWithElectron(fullPath: string): Promise<boolean> {
	try {
		const electron = require("electron") as {
			shell?: { trashItem?: (p: string) => Promise<void> };
		};
		if (electron?.shell?.trashItem) {
			await electron.shell.trashItem(fullPath);
			return true;
		}
	} catch {
		// Fall through to adapter.remove
	}
	return false;
}

export class LocalScanner implements LocalVaultPort {
	private readonly app: App;
	private readonly configDir: string;

	constructor(app: App, configDir?: string) {
		this.app = app;
		this.configDir = normalizeConfigDir(configDir ?? app.vault.configDir);
	}

	async listMarkdownSnapshots(
		shouldIgnorePath: (relativePath: string, isDir?: boolean) => boolean,
		scope?: ScanScopeOptions
	): Promise<{ files: Map<string, LocalFileSnapshot>; warnings: SyncLogDetail[] }> {
		const files = new Map<string, LocalFileSnapshot>();
		const warnings: SyncLogDetail[] = [];
		const activeConfigDir = normalizeConfigDir(scope?.configDir ?? this.configDir);

		// 1. Scan normal Vault Markdown files
		const mdFiles = this.app.vault.getMarkdownFiles();
		for (const file of mdFiles) {
			const relPath = normalizeRelativePath(file.path);
			if (isPathUnderConfigDir(relPath, activeConfigDir)) {
				continue;
			}
			if (shouldIgnorePath(relPath, false)) {
				continue;
			}
			try {
				const buf = await this.app.vault.readBinary(file);
				files.set(relPath, {
					relativePath: relPath,
					md5: computeMd5(buf),
					mtime: file.stat.mtime,
					size: buf.byteLength,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				warnings.push({
					path: relPath,
					action: "scan_local",
					level: "warn",
					message: `读取本地文件失败，已跳过：${msg}`,
				});
			}
		}

		// 2. Optionally scan hidden Obsidian config directory (.obsidian) via vault.adapter
		if (scope?.syncObsidianConfig) {
			await this.scanHiddenConfigDir(activeConfigDir, shouldIgnorePath, files, warnings);
		}

		return { files, warnings };
	}

	async readFileBinary(relativePath: string): Promise<ArrayBuffer> {
		const normalized = normalizeRelativePath(relativePath);
		if (isPathUnderConfigDir(normalized, this.configDir)) {
			if (!(await this.app.vault.adapter.exists(normalized))) {
				throw new Error(`本地配置文件不存在：${normalized}`);
			}
			return this.app.vault.adapter.readBinary(normalized);
		}

		const file = this.app.vault.getAbstractFileByPath(normalized);
		if (!(file instanceof TFile)) {
			throw new Error(`本地文件不存在：${normalized}`);
		}
		return this.app.vault.readBinary(file);
	}

	async writeFileBinary(relativePath: string, content: ArrayBuffer): Promise<LocalFileSnapshot> {
		const normalized = normalizeRelativePath(relativePath);
		if (isPathUnderConfigDir(normalized, this.configDir)) {
			return this.writeHiddenFileBinary(normalized, content);
		}

		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, content);
			return {
				relativePath: normalized,
				md5: computeMd5(content),
				mtime: existing.stat.mtime || Date.now(),
				size: content.byteLength,
			};
		}
		return this.createFileBinary(normalized, content);
	}

	async createFileBinary(relativePath: string, content: ArrayBuffer): Promise<LocalFileSnapshot> {
		const normalized = normalizeRelativePath(relativePath);
		if (isPathUnderConfigDir(normalized, this.configDir)) {
			return this.writeHiddenFileBinary(normalized, content);
		}

		const { dir } = splitDirAndName(normalized);
		if (dir) {
			await this.ensureLocalFolders(dir);
		}

		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, content);
			return {
				relativePath: normalized,
				md5: computeMd5(content),
				mtime: existing.stat.mtime || Date.now(),
				size: content.byteLength,
			};
		}

		const created = await this.app.vault.createBinary(normalized, content);
		return {
			relativePath: normalized,
			md5: computeMd5(content),
			mtime: created.stat.mtime || Date.now(),
			size: content.byteLength,
		};
	}

	async trashFile(relativePath: string): Promise<void> {
		const normalized = normalizeRelativePath(relativePath);
		if (isPathUnderConfigDir(normalized, this.configDir)) {
			if (!(await this.app.vault.adapter.exists(normalized))) {
				return;
			}
			const fsAdapter = this.app.vault.adapter as Partial<FileSystemAdapter>;
			if (typeof fsAdapter.getFullPath === "function") {
				const fullPath = fsAdapter.getFullPath(normalized);
				const trashed = await tryTrashWithElectron(fullPath);
				if (trashed) {
					return;
				}
			}
			await this.app.vault.adapter.remove(normalized);
			return;
		}

		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.app.fileManager.trashFile(existing);
		}
	}

	async exists(relativePath: string): Promise<boolean> {
		const normalized = normalizeRelativePath(relativePath);
		if (isPathUnderConfigDir(normalized, this.configDir)) {
			return this.app.vault.adapter.exists(normalized);
		}
		return this.app.vault.getAbstractFileByPath(normalized) !== null;
	}

	private async scanHiddenConfigDir(
		configDir: string,
		shouldIgnorePath: (relativePath: string, isDir?: boolean) => boolean,
		files: Map<string, LocalFileSnapshot>,
		warnings: SyncLogDetail[]
	): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(configDir))) {
			return;
		}

		const queue: string[] = [configDir];
		while (queue.length > 0) {
			const dir = queue.shift()!;
			let listed: { files: string[]; folders: string[] };
			try {
				listed = await adapter.list(dir);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				warnings.push({
					path: dir,
					action: "scan_local",
					level: "warn",
					message: `读取配置目录失败，已跳过：${msg}`,
				});
				continue;
			}

			for (const folder of listed.folders) {
				const normFolder = normalizeRelativePath(folder);
				if (shouldIgnorePath(normFolder, true)) {
					continue;
				}
				queue.push(normFolder);
			}

			for (const filePath of listed.files) {
				const normFile = normalizeRelativePath(filePath);
				if (shouldIgnorePath(normFile, false)) {
					continue;
				}
				try {
					const buf = await adapter.readBinary(normFile);
					const stat = await adapter.stat(normFile);
					files.set(normFile, {
						relativePath: normFile,
						md5: computeMd5(buf),
						mtime: stat?.mtime ?? Date.now(),
						size: buf.byteLength,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					warnings.push({
						path: normFile,
						action: "scan_local",
						level: "warn",
						message: `读取配置文件失败，已跳过：${msg}`,
					});
				}
			}
		}
	}

	private async writeHiddenFileBinary(
		normalizedPath: string,
		content: ArrayBuffer
	): Promise<LocalFileSnapshot> {
		const { dir } = splitDirAndName(normalizedPath);
		if (dir) {
			await this.ensureAdapterFolders(dir);
		}
		await this.app.vault.adapter.writeBinary(normalizedPath, content);
		const stat = await this.app.vault.adapter.stat(normalizedPath);
		return {
			relativePath: normalizedPath,
			md5: computeMd5(content),
			mtime: stat?.mtime ?? Date.now(),
			size: content.byteLength,
		};
	}

	private async ensureAdapterFolders(dirPath: string): Promise<void> {
		const segments = normalizeRelativePath(dirPath).split("/").filter(Boolean);
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			if (!(await this.app.vault.adapter.exists(current))) {
				try {
					await this.app.vault.adapter.mkdir(current);
				} catch {
					// Ignore race if directory already exists
				}
			}
		}
	}

	private async ensureLocalFolders(dirPath: string): Promise<void> {
		const segments = normalizeRelativePath(dirPath).split("/").filter(Boolean);
		let current = "";
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				try {
					await this.app.vault.createFolder(current);
				} catch {
					// Ignore if folder already exists concurrently
				}
			}
		}
	}
}
