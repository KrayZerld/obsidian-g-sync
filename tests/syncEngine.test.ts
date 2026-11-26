import { describe, expect, it, vi } from "vitest";
import { EMPTY_FILE_MD5, createDefaultSettings } from "../src/constants";
import { GoogleDriveClient } from "../src/drive/GoogleDriveClient";
import { AuthenticatedHttpClient } from "../src/drive/HttpClient";
import { computeMd5 } from "../src/sync/HashUtil";
import { SyncEngine } from "../src/sync/SyncEngine";
import type {
	BaselineData,
	DriveClientLike,
	GSyncSettings,
	LocalFileSnapshot,
	LocalVaultPort,
	RawHttpRequester,
	StoragePort,
	SyncLogEntry,
} from "../src/types";

function strToBuf(text: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(text);
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function createHarness() {
	const settings: GSyncSettings = {
		...createDefaultSettings(),
		clientId: "cid",
		clientSecret: "csec",
		remoteRepoPath: "Obsidian-Vault",
		deviceName: "TestPC",
		auth: {
			status: "authenticated",
			tokens: { accessToken: "tok", refreshToken: "ref", expiresAt: Date.now() + 3600_000 },
			remoteFolderId: "root-id",
			boundRemoteRepoPath: "Obsidian-Vault",
		},
	};

	let baseline: BaselineData | null = null;
	const logs: SyncLogEntry[] = [];

	const storage: StoragePort = {
		loadSettings: async () => settings,
		saveSettings: async () => {},
		loadBaseline: async () => baseline,
		saveBaseline: async (b) => {
			baseline = b;
		},
		resetBaseline: async () => {
			baseline = null;
		},
		loadLogs: async () => logs,
		appendLog: async (e) => {
			logs.unshift(e);
			return logs;
		},
		clearLogs: async () => {
			logs.length = 0;
		},
	};

	return {
		settings,
		storage,
		logs,
		getBaseline: () => baseline,
		setBaseline: (b: BaselineData | null) => {
			baseline = b;
		},
	};
}

describe("SyncEngine — concurrency lock, checkpoint persistence, suppression, empty files", () => {
	it("coalesces concurrent sync triggers via isSyncing lock & pendingSync follow-up", async () => {
		const { settings, storage } = createHarness();
		let scanCount = 0;
		let releaseFirstScan!: () => void;

		const firstScanBlocked = new Promise<void>((res) => {
			releaseFirstScan = res;
		});

		const drive: DriveClientLike = {
			getCurrentUser: async () => ({}),
			resolveOrCreateRepoFolder: async () => ({ folderId: "root-id", created: false, warnings: [] }),
			verifyFolderExists: async () => true,
			listAllMarkdownFiles: async () => {
				scanCount++;
				if (scanCount === 1) {
					await firstScanBlocked;
				}
				return { files: new Map(), folderIdCache: new Map(), warnings: [] };
			},
			ensureFolderPath: async () => "root-id",
			uploadNewFile: async () => ({ id: "id", name: "a.md", modifiedTime: "2026-11-24T00:00:00Z" }),
			updateFileContent: async () => ({ id: "id", name: "a.md", modifiedTime: "2026-11-24T00:00:00Z" }),
			downloadFile: async () => new ArrayBuffer(0),
			trashFile: async () => {},
		};

		const localVault: LocalVaultPort = {
			listMarkdownSnapshots: async () => ({ files: new Map(), warnings: [] }),
			readFileBinary: async () => new ArrayBuffer(0),
			writeFileBinary: async (p) => ({ relativePath: p, md5: EMPTY_FILE_MD5, mtime: 1, size: 0 }),
			createFileBinary: async (p) => ({ relativePath: p, md5: EMPTY_FILE_MD5, mtime: 1, size: 0 }),
			trashFile: async () => {},
			exists: async () => false,
		};

		const engine = new SyncEngine({
			getSettings: () => settings,
			saveSettings: async () => {},
			storage,
			tokenProvider: { getValidAccessToken: async () => "tok" },
			drive,
			localVault,
			pendingDelayMs: 25,
		});

		const firstRun = engine.runSync("manual");
		// Wait a tick so firstRun acquires lock
		await new Promise((r) => setTimeout(r, 10));
		expect(engine.isSyncing).toBe(true);

		// Fire multiple overlapping triggers while syncing
		const second = await engine.runSync("save");
		const third = await engine.runSync("interval");
		expect(second).toEqual({ executed: false, queued: true });
		expect(third).toEqual({ executed: false, queued: true });
		expect(scanCount).toBe(1);

		// Release first scan and wait for the single coalesced follow-up run
		releaseFirstScan();
		await firstRun;
		await new Promise((r) => setTimeout(r, 80));

		expect(scanCount).toBe(2);
		expect(engine.isSyncing).toBe(false);
		engine.dispose();
	});

	it("persists succeeded files to baseline even when a later file fails, and handles 0-byte files", async () => {
		const { settings, storage, getBaseline, logs } = createHarness();
		const localData = new Map<string, ArrayBuffer>([
			["a-empty.md", new ArrayBuffer(0)],
			["b-fail.md", strToBuf("boom")],
		]);

		const drive: DriveClientLike = {
			getCurrentUser: async () => ({}),
			resolveOrCreateRepoFolder: async () => ({ folderId: "root-id", created: false, warnings: [] }),
			verifyFolderExists: async () => true,
			listAllMarkdownFiles: async () => ({ files: new Map(), folderIdCache: new Map(), warnings: [] }),
			ensureFolderPath: async () => "root-id",
			uploadNewFile: async (_parent, name, content) => {
				if (name === "b-fail.md") {
					throw new Error("Simulated transient error");
				}
				return {
					id: "empty-file-id",
					name,
					md5Checksum: EMPTY_FILE_MD5,
					modifiedTime: "2026-11-24T12:00:00.000Z",
					size: String(content.byteLength),
				};
			},
			updateFileContent: async () => {
				throw new Error("unexpected");
			},
			downloadFile: async () => new ArrayBuffer(0),
			trashFile: async () => {},
		};

		const localVault: LocalVaultPort = {
			listMarkdownSnapshots: async () => {
				const files = new Map<string, LocalFileSnapshot>();
				for (const [p, buf] of localData.entries()) {
					files.set(p, { relativePath: p, md5: computeMd5(buf), mtime: 100, size: buf.byteLength });
				}
				return { files, warnings: [] };
			},
			readFileBinary: async (p) => localData.get(p)!,
			writeFileBinary: async (p, c) => ({
				relativePath: p,
				md5: computeMd5(c),
				mtime: 100,
				size: c.byteLength,
			}),
			createFileBinary: async (p, c) => ({
				relativePath: p,
				md5: computeMd5(c),
				mtime: 100,
				size: c.byteLength,
			}),
			trashFile: async () => {},
			exists: async (p) => localData.has(p),
		};

		const engine = new SyncEngine({
			getSettings: () => settings,
			saveSettings: async () => {},
			storage,
			tokenProvider: { getValidAccessToken: async () => "tok" },
			drive,
			localVault,
		});

		await engine.runSync("manual");

		const persisted = getBaseline();
		expect(persisted?.files["a-empty.md"]).toMatchObject({
			fileId: "empty-file-id",
			md5: EMPTY_FILE_MD5,
			size: 0,
		});
		expect(persisted?.files["b-fail.md"]).toBeUndefined();
		expect(logs[0].level).toBe("error");
		expect(logs[0].counts).toMatchObject({ uploaded: 1, errors: 1 });
	});

	it("suppresses plugin-initiated local path events during suppression TTL while allowing other paths", () => {
		const { settings, storage } = createHarness();
		let currentMs = 10_000;

		const engine = new SyncEngine({
			getSettings: () => settings,
			saveSettings: async () => {},
			storage,
			tokenProvider: { getValidAccessToken: async () => "tok" },
			drive: {} as DriveClientLike,
			localVault: {} as LocalVaultPort,
			now: () => new Date(currentMs),
			suppressWindowMs: 1500,
		});

		engine.markPathSuppressed("Notes/Synced.md");
		expect(engine.isPathSuppressed("Notes/Synced.md")).toBe(true);
		expect(engine.isPathSuppressed("notes\\synced.md")).toBe(true);
		expect(engine.isPathSuppressed("Notes/UserEditing.md")).toBe(false);

		currentMs += 1600;
		expect(engine.isPathSuppressed("Notes/Synced.md")).toBe(false);
	});

	it("prefers baseline-tracked fileId when Google Drive has duplicate .md filenames in same folder", async () => {
		const rawRequest: RawHttpRequester = vi.fn(async () => ({
			status: 200,
			headers: {},
			text: "",
			arrayBuffer: new ArrayBuffer(0),
			json: {
				files: [
					{
						id: "dup-newer-untracked",
						name: "dup.md",
						mimeType: "text/markdown",
						md5Checksum: "newmd5",
						modifiedTime: "2026-11-24T15:00:00.000Z",
						size: "12",
					},
					{
						id: "dup-tracked-baseline",
						name: "dup.md",
						mimeType: "text/markdown",
						md5Checksum: "basemd5",
						modifiedTime: "2026-11-24T12:00:00.000Z",
						size: "10",
					},
				],
			},
		}));

		const http = new AuthenticatedHttpClient({
			rawRequest,
			tokenProvider: { getValidAccessToken: async () => "tok" },
		});
		const drive = new GoogleDriveClient(http);

		const scan = await drive.listAllMarkdownFiles("root-folder", () => false, {
			"dup.md": {
				fileId: "dup-tracked-baseline",
				md5: "basemd5",
				localMtime: 1000,
				remoteMtime: "2026-11-24T12:00:00.000Z",
				size: 10,
			},
		});

		expect(scan.files.get("dup.md")?.fileId).toBe("dup-tracked-baseline");
		expect(scan.warnings).toHaveLength(1);
		expect(scan.warnings[0].level).toBe("warn");
	});
});
