import {
	DEFAULT_CONFIG_DIR,
	EMPTY_FILE_MD5,
	PENDING_SYNC_DELAY_MS,
	PLUGIN_ID,
	SELF_EVENT_SUPPRESS_MS,
	normalizeConfigDir,
} from "../constants";
import { splitRepoPath } from "../drive/GoogleDriveClient";
import {
	AuthExpiredError,
	type BaselineData,
	type BaselineEntry,
	type DiffPlanItem,
	type DriveClientLike,
	type GSyncSettings,
	type LocalVaultPort,
	type LogLevel,
	type StoragePort,
	type SyncLogDetail,
	type SyncLogEntry,
	type SyncRuntimeStatus,
	type SyncSummaryCounts,
	type SyncTrigger,
	type TokenProvider,
} from "../types";
import {
	buildConflictPath,
	computeMd5,
	normalizeRelativePath,
	shortenDisplayPath,
	splitDirAndName,
} from "./HashUtil";
import { IgnoreMatcher } from "./IgnoreMatcher";
import { computeSyncPlan } from "./ThreeWayDiff";

export interface SyncEngineDeps {
	getSettings: () => GSyncSettings;
	saveSettings: () => Promise<void>;
	storage: StoragePort;
	tokenProvider: TokenProvider;
	drive: DriveClientLike;
	localVault: LocalVaultPort;
	onStatusChange?: (status: SyncRuntimeStatus) => void;
	onLogAppended?: (entry: SyncLogEntry) => void;
	onNotice?: (message: string, timeoutMs?: number) => void;
	onOwnConfigUpdated?: () => Promise<void>;
	configDir?: string;
	now?: () => Date;
	pendingDelayMs?: number;
	suppressWindowMs?: number;
}

export interface SyncExecutionResult {
	executed: boolean;
	queued?: boolean;
	logEntry?: SyncLogEntry;
}

function createEmptyCounts(): SyncSummaryCounts {
	return {
		uploaded: 0,
		downloaded: 0,
		deletedLocal: 0,
		deletedRemote: 0,
		conflicts: 0,
		skipped: 0,
		errors: 0,
	};
}

function formatSummaryText(counts: SyncSummaryCounts, isInitialSync: boolean): string {
	const totalDeletes = counts.deletedLocal + counts.deletedRemote;
	const base = `上传 ${counts.uploaded} / 下载 ${counts.downloaded} / 删除 ${totalDeletes} / 冲突 ${counts.conflicts}`;
	const prefix = isInitialSync ? "初始化完成：" : "";
	return counts.errors > 0 ? `${prefix}${base} / 失败 ${counts.errors}` : `${prefix}${base}`;
}

export class SyncEngine {
	private readonly deps: SyncEngineDeps;
	private isSyncingFlag = false;
	private pendingSync = false;
	private pendingTrigger: SyncTrigger | null = null;
	private pendingTimer: ReturnType<typeof setTimeout> | null = null;
	private disposed = false;
	private suppressedPaths = new Map<string, number>();
	private runtimeStatus: SyncRuntimeStatus = { kind: "idle" };

	constructor(deps: SyncEngineDeps) {
		this.deps = deps;
	}

	get isSyncing(): boolean {
		return this.isSyncingFlag;
	}

	get status(): SyncRuntimeStatus {
		return { ...this.runtimeStatus };
	}

	private nowDate(): Date {
		return this.deps.now ? this.deps.now() : new Date();
	}

	private nowMs(): number {
		return this.nowDate().getTime();
	}

	private emitStatus(status: SyncRuntimeStatus): void {
		this.runtimeStatus = status;
		this.deps.onStatusChange?.({ ...status });
	}

	refreshIdleStatusFromSettings(): void {
		if (this.isSyncingFlag) return;
		const settings = this.deps.getSettings();
		if (settings.auth.status === "expired") {
			this.emitStatus({
				kind: "error",
				lastSyncAt: this.runtimeStatus.lastSyncAt,
				lastError: "Google 授权已失效，请前往 Auth 页重新授权。",
			});
			return;
		}
		if (settings.auth.status !== "authenticated" || !settings.auth.tokens?.refreshToken) {
			this.emitStatus({
				kind: "unauthenticated",
				lastError: "尚未授权 Google 账号",
			});
			return;
		}
		if (!settings.remoteRepoPath.trim()) {
			this.emitStatus({
				kind: "error",
				lastSyncAt: this.runtimeStatus.lastSyncAt,
				lastError: "未配置云端仓库路径",
			});
			return;
		}
		if (this.runtimeStatus.kind !== "error") {
			this.emitStatus({
				kind: "idle",
				lastSyncAt: this.runtimeStatus.lastSyncAt,
			});
		}
	}

	markPathSuppressed(relativePath: string): void {
		const normalized = normalizeRelativePath(relativePath);
		const windowMs = this.deps.suppressWindowMs ?? SELF_EVENT_SUPPRESS_MS;
		this.suppressedPaths.set(normalized.toLowerCase(), this.nowMs() + windowMs);
	}

	isPathSuppressed(relativePath: string): boolean {
		const normalized = normalizeRelativePath(relativePath).toLowerCase();
		const expiresAt = this.suppressedPaths.get(normalized);
		if (expiresAt === undefined) return false;
		if (this.nowMs() <= expiresAt) {
			return true;
		}
		this.suppressedPaths.delete(normalized);
		return false;
	}

	private pruneSuppressedPaths(): void {
		const now = this.nowMs();
		for (const [key, exp] of this.suppressedPaths.entries()) {
			if (now > exp) {
				this.suppressedPaths.delete(key);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.pendingSync = false;
		this.pendingTrigger = null;
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
	}

	async runSync(trigger: SyncTrigger): Promise<SyncExecutionResult> {
		if (this.disposed) {
			return { executed: false };
		}

		const settings = this.deps.getSettings();

		// Precondition 1: Auth state
		if (settings.auth.status === "expired") {
			const msg = "Google 授权已失效，请前往设置页 Auth 标签重新登录授权。";
			this.emitStatus({ kind: "error", lastSyncAt: this.runtimeStatus.lastSyncAt, lastError: msg });
			if (trigger === "manual") {
				this.deps.onNotice?.(`g-Sync：${msg}`, 6000);
			}
			return { executed: false };
		}
		if (settings.auth.status !== "authenticated" || !settings.auth.tokens?.refreshToken) {
			const msg = "尚未完成 Google 账号授权，已跳过同步。";
			this.emitStatus({ kind: "unauthenticated", lastError: msg });
			if (trigger === "manual") {
				this.deps.onNotice?.(`g-Sync：${msg}`, 5000);
			}
			return { executed: false };
		}

		// Precondition 2: Cloud repo path
		const rawRepoPath = settings.remoteRepoPath.trim();
		if (!rawRepoPath) {
			const msg = "未配置「云端仓库」路径，已禁止发起同步。";
			this.emitStatus({ kind: "error", lastSyncAt: this.runtimeStatus.lastSyncAt, lastError: msg });
			const entry = await this.recordLog({
				trigger,
				level: "error",
				summaryText: msg,
				details: [{ action: "precheck", level: "error", message: msg }],
			});
			if (trigger === "manual") {
				this.deps.onNotice?.(`g-Sync：${msg}`, 5000);
			}
			return { executed: false, logEntry: entry };
		}

		// Precondition 3: Mutual exclusion lock + pendingSync coalescing
		if (this.isSyncingFlag) {
			this.pendingSync = true;
			if (!this.pendingTrigger || trigger === "manual") {
				this.pendingTrigger = trigger;
			}
			return { executed: false, queued: true };
		}

		this.isSyncingFlag = true;
		const startMs = this.nowMs();
		const counts = createEmptyCounts();
		const details: SyncLogDetail[] = [];
		let folderId: string | null = null;
		let workingBaseline: Record<string, BaselineEntry> | null = null;
		let isInitialSync = false;
		let authExpired = false;
		let fatalError: string | null = null;
		let syncedOwnConfigData = false;
		const configDir = normalizeConfigDir(this.deps.configDir ?? DEFAULT_CONFIG_DIR);
		const ownDataJsonPath = `${configDir}/plugins/${PLUGIN_ID}/data.json`.toLowerCase();

		try {
			this.emitStatus({
				kind: "syncing",
				phase: "auth...",
				lastSyncAt: this.runtimeStatus.lastSyncAt,
			});

			// Ensure access token is valid (refreshes automatically if < 2 min to expiry)
			await this.deps.tokenProvider.getValidAccessToken(false);

			// Resolve or verify bound remote folder
			this.emitStatus({
				kind: "syncing",
				phase: "resolving folder...",
				lastSyncAt: this.runtimeStatus.lastSyncAt,
			});
			const normalizedRepoPath = splitRepoPath(rawRepoPath).join("/");
			folderId = await this.ensureBoundRemoteFolder(settings, normalizedRepoPath, details);

			// Load baseline
			const loadedBaseline = await this.deps.storage.loadBaseline();
			const hasValidBaseline = loadedBaseline !== null && loadedBaseline.folderId === folderId;
			isInitialSync = !hasValidBaseline;
			const baselineFiles: Record<string, BaselineEntry> = hasValidBaseline
				? loadedBaseline.files
				: {};

			const scope = {
				syncObsidianConfig: settings.syncObsidianConfig,
				configDir,
			};
			const ignoreMatcher = new IgnoreMatcher(settings.ignoreRules, scope);

			// Collect local & remote snapshots in parallel
			this.emitStatus({
				kind: "syncing",
				phase: "scanning...",
				lastSyncAt: this.runtimeStatus.lastSyncAt,
			});

			const [localScan, remoteScan] = await Promise.all([
				this.deps.localVault.listMarkdownSnapshots(
					(p, isDir) => ignoreMatcher.isIgnored(p, Boolean(isDir)),
					scope
				),
				this.deps.drive.listAllMarkdownFiles(
					folderId,
					(p, isDir) => ignoreMatcher.isIgnored(p, Boolean(isDir)),
					baselineFiles,
					scope
				),
			]);

			details.push(...localScan.warnings, ...remoteScan.warnings);

			// Compute 3-way diff plan
			this.emitStatus({
				kind: "syncing",
				phase: "diffing...",
				lastSyncAt: this.runtimeStatus.lastSyncAt,
			});

			const diffResult = computeSyncPlan({
				localFiles: localScan.files,
				remoteFiles: remoteScan.files,
				baselineFiles,
				isInitialSync,
				ignoreMatcher,
			});
			details.push(...diffResult.warnings);

			// Initialize workingBaseline (drop paths now matched by ignore rules without deleting files)
			workingBaseline = {};
			if (!isInitialSync) {
				for (const [path, entry] of Object.entries(baselineFiles)) {
					if (!ignoreMatcher.isIgnored(path, false)) {
						workingBaseline[path] = { ...entry };
					}
				}
			}

			const existingPaths = new Set<string>([
				...localScan.files.keys(),
				...remoteScan.files.keys(),
			]);
			const folderCache = remoteScan.folderIdCache;

			const actionableItems = diffResult.items.filter((it) => it.action !== "noop");
			let processed = 0;

			for (const item of actionableItems) {
				processed++;
				this.emitStatus({
					kind: "syncing",
					phase: `${processed}/${actionableItems.length} ${shortenDisplayPath(item.relativePath)}`,
					lastSyncAt: this.runtimeStatus.lastSyncAt,
				});

				if (item.warning) {
					details.push({
						path: item.relativePath,
						action: item.action,
						level: "warn",
						message: item.warning,
					});
				}

				try {
					await this.executePlanItem({
						item,
						folderId,
						folderCache,
						workingBaseline,
						existingPaths,
						deviceName: settings.deviceName,
						counts,
						details,
					});
					if (
						(item.action === "download_new" ||
							item.action === "download_update" ||
							item.action === "resolve_conflict") &&
						item.relativePath.toLowerCase() === ownDataJsonPath
					) {
						syncedOwnConfigData = true;
					}
				} catch (err) {
					if (err instanceof AuthExpiredError) {
						throw err;
					}
					counts.errors++;
					const msg = err instanceof Error ? err.message : String(err);
					details.push({
						path: item.relativePath,
						action: item.action,
						level: "error",
						message: `Error: ${msg}`,
					});
				}
			}
		} catch (err) {
			if (err instanceof AuthExpiredError) {
				authExpired = true;
				fatalError = err.message;
				details.push({
					action: "auth",
					level: "error",
					message: err.message,
				});
			} else {
				fatalError = err instanceof Error ? err.message : String(err);
				details.push({
					action: "sync",
					level: "error",
					message: `同步中断：${fatalError}`,
				});
			}
		} finally {
			// Persist checkpoint baseline for all succeeded items
			if (folderId && workingBaseline) {
				try {
					const baselineData: BaselineData = {
						version: 1,
						folderId,
						updatedAt: this.nowDate().toISOString(),
						files: workingBaseline,
					};
					await this.deps.storage.saveBaseline(baselineData);
				} catch (saveErr) {
					const msg = saveErr instanceof Error ? saveErr.message : String(saveErr);
					details.push({
						action: "save_baseline",
						level: "error",
						message: `保存基线文件失败：${msg}`,
					});
					counts.errors++;
				}
			}

			this.pruneSuppressedPaths();
			this.isSyncingFlag = false;
		}

		if (syncedOwnConfigData && this.deps.onOwnConfigUpdated) {
			try {
				await this.deps.onOwnConfigUpdated();
			} catch {
				// Non-fatal: next restart will pick up updated shared data.json
			}
		}

		const durationMs = Math.max(0, this.nowMs() - startMs);
		const finishedAt = this.nowDate().toISOString();
		const effectiveTrigger: SyncTrigger = isInitialSync ? "init" : trigger;

		const hasWarnings = details.some((d) => d.level === "warn");
		let level: LogLevel = "success";
		if (fatalError || counts.errors > 0) {
			level = "error";
		} else if (counts.conflicts > 0 || hasWarnings) {
			level = "warn";
		}

		const summaryText = fatalError
			? `${fatalError}`
			: formatSummaryText(counts, isInitialSync);

		const logEntry = await this.recordLog({
			trigger: effectiveTrigger,
			level,
			summaryText,
			counts: fatalError ? undefined : counts,
			durationMs,
			details,
		});

		if (authExpired) {
			this.emitStatus({
				kind: "error",
				lastSyncAt: this.runtimeStatus.lastSyncAt,
				lastError: fatalError ?? "Google 授权已失效",
			});
			this.deps.onNotice?.(`g-Sync：${fatalError ?? "授权已失效，请重新登录。"}`, 7000);
			this.pendingSync = false;
			this.pendingTrigger = null;
			return { executed: true, logEntry };
		}

		if (fatalError || counts.errors > 0) {
			const errSummary = fatalError ?? `同步完成但有 ${counts.errors} 项失败`;
			this.emitStatus({
				kind: "error",
				lastSyncAt: finishedAt,
				lastError: errSummary,
			});
			this.deps.onNotice?.(`g-Sync 同步异常：${errSummary}`, 6000);
		} else {
			this.emitStatus({
				kind: "idle",
				lastSyncAt: finishedAt,
			});
			if (counts.conflicts > 0) {
				this.deps.onNotice?.(
					`g-Sync：检测到 ${counts.conflicts} 个文件冲突，已保留本地冲突副本，请手动合并。`,
					7000
				);
			} else if (trigger === "manual") {
				this.deps.onNotice?.(`g-Sync：${summaryText}`, 4000);
			}
		}

		// Schedule coalesced pending sync if another trigger arrived while running
		if (this.pendingSync && !this.disposed) {
			const nextTrigger = this.pendingTrigger ?? "save";
			this.pendingSync = false;
			this.pendingTrigger = null;
			const delayMs = this.deps.pendingDelayMs ?? PENDING_SYNC_DELAY_MS;
			if (this.pendingTimer) {
				clearTimeout(this.pendingTimer);
			}
			this.pendingTimer = setTimeout(() => {
				this.pendingTimer = null;
				void this.runSync(nextTrigger);
			}, delayMs);
		}

		return { executed: true, logEntry };
	}

	private async ensureBoundRemoteFolder(
		settings: GSyncSettings,
		normalizedRepoPath: string,
		details: SyncLogDetail[]
	): Promise<string> {
		const existingId = settings.auth.remoteFolderId;
		const existingPath = settings.auth.boundRemoteRepoPath;

		if (existingId && existingPath === normalizedRepoPath) {
			const stillValid = await this.deps.drive.verifyFolderExists(existingId);
			if (stillValid) {
				return existingId;
			}
			details.push({
				path: normalizedRepoPath,
				action: "resolve_folder",
				level: "warn",
				message: `此前绑定的云端目录（ID: ${existingId}）已不存在或被移入回收站，将重新查找/创建。`,
			});
		}

		const resolved = await this.deps.drive.resolveOrCreateRepoFolder(normalizedRepoPath);
		details.push(...resolved.warnings);
		if (resolved.created) {
			details.push({
				path: normalizedRepoPath,
				action: "create_folder",
				level: "info",
				message: `已在 Google Drive 自动创建云端仓库目录 "${normalizedRepoPath}"（ID: ${resolved.folderId}）。`,
			});
		}

		settings.auth.remoteFolderId = resolved.folderId;
		settings.auth.boundRemoteRepoPath = normalizedRepoPath;
		await this.deps.saveSettings();
		return resolved.folderId;
	}

	private async executePlanItem(params: {
		item: DiffPlanItem;
		folderId: string;
		folderCache: Map<string, string>;
		workingBaseline: Record<string, BaselineEntry>;
		existingPaths: Set<string>;
		deviceName: string;
		counts: SyncSummaryCounts;
		details: SyncLogDetail[];
	}): Promise<void> {
		const {
			item,
			folderId,
			folderCache,
			workingBaseline,
			existingPaths,
			deviceName,
			counts,
			details,
		} = params;

		switch (item.action) {
			case "record_baseline": {
				if (item.local && item.remote) {
					workingBaseline[item.relativePath] = {
						fileId: item.remote.fileId,
						md5: item.local.md5,
						localMtime: item.local.mtime,
						remoteMtime: item.remote.modifiedTime,
						size: item.local.size,
					};
					counts.skipped++;
				}
				break;
			}

			case "upload_new": {
				const content = await this.deps.localVault.readFileBinary(item.relativePath);
				const { dir, name } = splitDirAndName(item.relativePath);
				const parentId = await this.deps.drive.ensureFolderPath(folderId, dir, folderCache);
				const meta = await this.deps.drive.uploadNewFile(parentId, name, content);
				const md5 = meta.md5Checksum ?? computeMd5(content) ?? EMPTY_FILE_MD5;

				workingBaseline[item.relativePath] = {
					fileId: meta.id,
					md5,
					localMtime: item.local?.mtime ?? this.nowMs(),
					remoteMtime: meta.modifiedTime,
					size: content.byteLength,
				};
				counts.uploaded++;
				details.push({
					path: item.relativePath,
					action: "upload_new",
					level: "success",
					message: "Upload",
				});
				break;
			}

			case "upload_update": {
				const targetFileId = item.remote?.fileId ?? item.baseline?.fileId;
				if (!targetFileId) {
					throw new Error("缺少远端 fileId，无法覆盖更新。");
				}
				const content = await this.deps.localVault.readFileBinary(item.relativePath);
				const meta = await this.deps.drive.updateFileContent(
					targetFileId,
					content,
					item.relativePath
				);
				const md5 = meta.md5Checksum ?? computeMd5(content);

				workingBaseline[item.relativePath] = {
					fileId: meta.id,
					md5,
					localMtime: item.local?.mtime ?? this.nowMs(),
					remoteMtime: meta.modifiedTime,
					size: content.byteLength,
				};
				counts.uploaded++;
				details.push({
					path: item.relativePath,
					action: "upload_update",
					level: "success",
					message: "Upload",
				});
				break;
			}

			case "download_new":
			case "download_update": {
				if (!item.remote) {
					throw new Error("缺少远端快照元数据，无法下载。");
				}
				const remoteContent = await this.deps.drive.downloadFile(item.remote.fileId);
				this.markPathSuppressed(item.relativePath);
				const localSnap =
					item.action === "download_new"
						? await this.deps.localVault.createFileBinary(item.relativePath, remoteContent)
						: await this.deps.localVault.writeFileBinary(item.relativePath, remoteContent);
				this.markPathSuppressed(item.relativePath);

				workingBaseline[item.relativePath] = {
					fileId: item.remote.fileId,
					md5: localSnap.md5,
					localMtime: localSnap.mtime,
					remoteMtime: item.remote.modifiedTime,
					size: localSnap.size,
				};
				counts.downloaded++;
				details.push({
					path: item.relativePath,
					action: item.action,
					level: "success",
					message: "Download",
				});
				break;
			}

			case "delete_remote": {
				const targetFileId = item.remote?.fileId ?? item.baseline?.fileId;
				if (targetFileId) {
					await this.deps.drive.trashFile(targetFileId);
				}
				delete workingBaseline[item.relativePath];
				counts.deletedRemote++;
				details.push({
					path: item.relativePath,
					action: "delete_remote",
					level: "info",
					message: "Delete",
				});
				break;
			}

			case "delete_local": {
				this.markPathSuppressed(item.relativePath);
				await this.deps.localVault.trashFile(item.relativePath);
				this.markPathSuppressed(item.relativePath);
				delete workingBaseline[item.relativePath];
				counts.deletedLocal++;
				details.push({
					path: item.relativePath,
					action: "delete_local",
					level: "info",
					message: "Delete",
				});
				break;
			}

			case "remove_baseline": {
				delete workingBaseline[item.relativePath];
				counts.skipped++;
				details.push({
					path: item.relativePath,
					action: "remove_baseline",
					level: "info",
					message: "Delete",
				});
				break;
			}

			case "resolve_conflict": {
				if (!item.remote) {
					throw new Error("冲突处理缺少远端文件元数据。");
				}
				// 1. Read local content before overwriting original path
				const localContent = await this.deps.localVault.readFileBinary(item.relativePath);
				const conflictPath = buildConflictPath(
					item.relativePath,
					deviceName,
					this.nowDate(),
					existingPaths
				);
				existingPaths.add(conflictPath);

				// 2. Save local content as conflict copy
				this.markPathSuppressed(conflictPath);
				const conflictLocalSnap = await this.deps.localVault.createFileBinary(
					conflictPath,
					localContent
				);
				this.markPathSuppressed(conflictPath);

				// 3. Download remote content and overwrite original path
				const remoteContent = await this.deps.drive.downloadFile(item.remote.fileId);
				this.markPathSuppressed(item.relativePath);
				const updatedOrigLocalSnap = await this.deps.localVault.writeFileBinary(
					item.relativePath,
					remoteContent
				);
				this.markPathSuppressed(item.relativePath);

				// 4. Upload conflict copy to Google Drive in the same sync cycle
				const { dir, name } = splitDirAndName(conflictPath);
				const parentId = await this.deps.drive.ensureFolderPath(folderId, dir, folderCache);
				const conflictRemoteMeta = await this.deps.drive.uploadNewFile(
					parentId,
					name,
					localContent
				);

				// 5. Update baseline for BOTH original path and conflict copy
				workingBaseline[item.relativePath] = {
					fileId: item.remote.fileId,
					md5: updatedOrigLocalSnap.md5,
					localMtime: updatedOrigLocalSnap.mtime,
					remoteMtime: item.remote.modifiedTime,
					size: updatedOrigLocalSnap.size,
				};
				workingBaseline[conflictPath] = {
					fileId: conflictRemoteMeta.id,
					md5: conflictRemoteMeta.md5Checksum ?? conflictLocalSnap.md5,
					localMtime: conflictLocalSnap.mtime,
					remoteMtime: conflictRemoteMeta.modifiedTime,
					size: conflictLocalSnap.size,
				};

				counts.conflicts++;
				details.push({
					path: item.relativePath,
					action: "resolve_conflict",
					level: "warn",
					message: `Conflict: ${shortenDisplayPath(conflictPath)}`,
				});
				break;
			}

			case "noop":
			default:
				break;
		}
	}

	private async recordLog(params: {
		trigger: SyncTrigger;
		level: LogLevel;
		summaryText: string;
		counts?: SyncSummaryCounts;
		durationMs?: number;
		details: SyncLogDetail[];
	}): Promise<SyncLogEntry> {
		const entry: SyncLogEntry = {
			id: `${this.nowMs()}-${Math.random().toString(36).slice(2, 8)}`,
			timestamp: this.nowDate().toISOString(),
			trigger: params.trigger,
			level: params.level,
			summaryText: params.summaryText,
			counts: params.counts,
			durationMs: params.durationMs,
			details: params.details,
		};
		await this.deps.storage.appendLog(entry);
		this.deps.onLogAppended?.(entry);
		return entry;
	}
}
