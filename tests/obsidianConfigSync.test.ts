import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings, isSyncableFilePath } from "../src/constants";
import { GoogleDriveClient, guessContentType } from "../src/drive/GoogleDriveClient";
import { AuthenticatedHttpClient } from "../src/drive/HttpClient";
import { StorageService, type FileAdapterLike } from "../src/storage/StorageService";
import { buildConflictPath, computeMd5 } from "../src/sync/HashUtil";
import { IgnoreMatcher } from "../src/sync/IgnoreMatcher";
import { SyncEngine } from "../src/sync/SyncEngine";
import { computeSyncPlan } from "../src/sync/ThreeWayDiff";
import type {
	BaselineData,
	DriveClientLike,
	GSyncSettings,
	LocalFileSnapshot,
	LocalVaultPort,
	RawHttpRequester,
	RemoteFileSnapshot,
	StoragePort,
	SyncLogEntry,
} from "../src/types";

function strToBuf(text: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(text);
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

describe(".obsidian config sync & local.json device isolation", () => {
	it("migrates legacy deviceName & auth out of data.json into local.json and preserves device-local fields on reload", async () => {
		let savedDataJson: Record<string, unknown> = {
			clientId: "cid-shared",
			clientSecret: "sec-shared",
			remoteRepoPath: "Obsidian-Vault",
			deviceName: "LegacyPC",
			auth: {
				status: "authenticated",
				accountEmail: "captain@example.com",
				tokens: { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 3600_000 },
			},
			intervalMinutes: 5,
			syncObsidianConfig: true,
		};
		const fsMap = new Map<string, string>();

		const adapter: FileAdapterLike = {
			exists: async (p) => fsMap.has(p),
			read: async (p) => fsMap.get(p)!,
			write: async (p, data) => {
				fsMap.set(p, data);
			},
			remove: async (p) => {
				fsMap.delete(p);
			},
			mkdir: async () => {},
		};

		const storage = new StorageService(
			{
				loadData: async () => savedDataJson,
				saveData: async (d) => {
					savedDataJson = d as Record<string, unknown>;
				},
			},
			adapter,
			".obsidian/plugins/obsidian-g-sync"
		);

		const loaded = await storage.loadSettings();
		expect(loaded.deviceName).toBe("LegacyPC");
		expect(loaded.auth.accountEmail).toBe("captain@example.com");
		expect(loaded.syncObsidianConfig).toBe(true);

		// Legacy deviceName & auth must be stripped from data.json and moved to local.json
		expect(savedDataJson.deviceName).toBeUndefined();
		expect(savedDataJson.auth).toBeUndefined();
		expect(fsMap.has(".obsidian/plugins/obsidian-g-sync/local.json")).toBe(true);
		const localJson = JSON.parse(fsMap.get(".obsidian/plugins/obsidian-g-sync/local.json")!);
		expect(localJson.deviceName).toBe("LegacyPC");
		expect(localJson.auth.accountEmail).toBe("captain@example.com");

		// Simulate remote sync overwriting data.json with updated intervalMinutes
		savedDataJson = {
			...savedDataJson,
			intervalMinutes: 15,
		};
		const reloaded = await storage.reloadSharedSettings(loaded);
		expect(reloaded.intervalMinutes).toBe(15);
		expect(reloaded.deviceName).toBe("LegacyPC");
		expect(reloaded.auth.accountEmail).toBe("captain@example.com");
	});

	it("hard-excludes workspace.json, workspace-mobile.json, local.json, baseline.json, logs.json even with user ! rules", () => {
		const userOverrideAttempt = [
			"!.obsidian/workspace.json",
			"!.obsidian/workspace-mobile.json",
			"!.obsidian/plugins/obsidian-g-sync/local.json",
			"!.obsidian/plugins/obsidian-g-sync/baseline.json",
			"!.obsidian/plugins/obsidian-g-sync/logs.json",
		].join("\n");

		const disabled = new IgnoreMatcher(userOverrideAttempt, { syncObsidianConfig: false });
		expect(disabled.isIgnored(".obsidian/app.json")).toBe(true);
		expect(disabled.isIgnored(".obsidian/plugins/obsidian-g-sync/data.json")).toBe(true);

		const enabled = new IgnoreMatcher(userOverrideAttempt, { syncObsidianConfig: true });
		expect(enabled.isIgnored(".obsidian/app.json")).toBe(false);
		expect(enabled.isIgnored(".obsidian/snippets/custom.css")).toBe(false);
		expect(enabled.isIgnored(".obsidian/plugins/obsidian-i-chat/main.js")).toBe(false);
		expect(enabled.isIgnored(".obsidian/plugins/obsidian-g-sync/data.json")).toBe(false);

		// Hard-excluded device/runtime files stay ignored regardless of ! rules
		expect(enabled.isIgnored(".obsidian/workspace.json")).toBe(true);
		expect(enabled.isIgnored(".obsidian/workspace-mobile.json")).toBe(true);
		expect(enabled.isIgnored(".obsidian/plugins/obsidian-g-sync/local.json")).toBe(true);
		expect(enabled.isIgnored(".obsidian/plugins/obsidian-g-sync/baseline.json")).toBe(true);
		expect(enabled.isIgnored(".obsidian/plugins/obsidian-g-sync/logs.json")).toBe(true);
	});

	it("does not delete previously synced .obsidian files when turning syncObsidianConfig off", () => {
		const matcher = new IgnoreMatcher("", { syncObsidianConfig: false });
		const plan = computeSyncPlan({
			localFiles: new Map<string, LocalFileSnapshot>(),
			remoteFiles: new Map<string, RemoteFileSnapshot>([
				[
					".obsidian/app.json",
					{
						fileId: "f-app",
						relativePath: ".obsidian/app.json",
						md5: "aaa",
						modifiedTime: "2026-11-25T10:00:00Z",
						size: 10,
						parentId: "p-obs",
					},
				],
			]),
			baselineFiles: {
				".obsidian/app.json": {
					fileId: "f-app",
					md5: "aaa",
					localMtime: 1000,
					remoteMtime: "2026-11-25T10:00:00Z",
					size: 10,
				},
			},
			isInitialSync: false,
			ignoreMatcher: matcher,
		});

		expect(plan.items).toHaveLength(0);
	});

	it("preserves original extensions for conflict copies of .obsidian config files", () => {
		const date = new Date(2026, 10, 25, 19, 55, 0);
		expect(buildConflictPath(".obsidian/app.json", "DeskPC", date)).toBe(
			".obsidian/app.conflict-DeskPC-20261125-195500.json"
		);
		expect(buildConflictPath(".obsidian/snippets/ui.css", "DeskPC", date)).toBe(
			".obsidian/snippets/ui.conflict-DeskPC-20261125-195500.css"
		);
		expect(buildConflictPath(".obsidian/themes/Neon/LICENSE", "DeskPC", date)).toBe(
			".obsidian/themes/Neon/LICENSE.conflict-DeskPC-20261125-195500"
		);
	});

	it("scans non-md files inside .obsidian on Drive while keeping vault root md-only", async () => {
		expect(isSyncableFilePath("notes/a.md", true)).toBe(true);
		expect(isSyncableFilePath("attachments/img.png", true)).toBe(false);
		expect(isSyncableFilePath(".obsidian/app.json", true)).toBe(true);
		expect(isSyncableFilePath(".obsidian/app.json", false)).toBe(false);
		expect(guessContentType("app.json")).toBe("application/json; charset=utf-8");
		expect(guessContentType("styles.css")).toBe("text/css; charset=utf-8");
		expect(guessContentType("main.js")).toBe("application/javascript; charset=utf-8");

		const rawRequest: RawHttpRequester = vi.fn(async (opts) => {
			if (decodeURIComponent(opts.url).includes("'root-id'")) {
				return {
					status: 200,
					headers: {},
					text: "",
					arrayBuffer: new ArrayBuffer(0),
					json: {
						files: [
							{
								id: "dir-obs",
								name: ".obsidian",
								mimeType: "application/vnd.google-apps.folder",
								modifiedTime: "2026-11-25T10:00:00Z",
							},
							{
								id: "f-note",
								name: "hello.md",
								mimeType: "text/markdown",
								md5Checksum: "m1",
								modifiedTime: "2026-11-25T10:00:00Z",
								size: "5",
							},
							{
								id: "f-img",
								name: "pic.png",
								mimeType: "image/png",
								md5Checksum: "m2",
								modifiedTime: "2026-11-25T10:00:00Z",
								size: "99",
							},
						],
					},
				};
			}
			return {
				status: 200,
				headers: {},
				text: "",
				arrayBuffer: new ArrayBuffer(0),
				json: {
					files: [
						{
							id: "f-app",
							name: "app.json",
							mimeType: "application/json",
							md5Checksum: "m3",
							modifiedTime: "2026-11-25T10:00:00Z",
							size: "20",
						},
						{
							id: "f-ws",
							name: "workspace.json",
							mimeType: "application/json",
							md5Checksum: "m4",
							modifiedTime: "2026-11-25T10:00:00Z",
							size: "50",
						},
					],
				},
			};
		});

		const http = new AuthenticatedHttpClient({
			rawRequest,
			tokenProvider: { getValidAccessToken: async () => "tok" },
		});
		const drive = new GoogleDriveClient(http);
		const matcher = new IgnoreMatcher("", { syncObsidianConfig: true });

		const scan = await drive.listAllMarkdownFiles(
			"root-id",
			(p, isDir) => matcher.isIgnored(p, Boolean(isDir)),
			undefined,
			{ syncObsidianConfig: true, configDir: ".obsidian" }
		);

		expect(Array.from(scan.files.keys()).sort()).toEqual([".obsidian/app.json", "hello.md"]);
	});

	it("invokes onOwnConfigUpdated when remote obsidian-g-sync/data.json is downloaded", async () => {
		const settings: GSyncSettings = {
			...createDefaultSettings(),
			clientId: "cid",
			clientSecret: "csec",
			remoteRepoPath: "Obsidian-Vault",
			deviceName: "DeviceA",
			syncObsidianConfig: true,
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
			clearLogs: async () => {},
		};

		const remoteConfigText = JSON.stringify({ intervalMinutes: 20, syncObsidianConfig: true });
		const remoteConfigBuf = strToBuf(remoteConfigText);
		const ownDataPath = ".obsidian/plugins/obsidian-g-sync/data.json";

		const drive: DriveClientLike = {
			getCurrentUser: async () => ({}),
			resolveOrCreateRepoFolder: async () => ({ folderId: "root-id", created: false, warnings: [] }),
			verifyFolderExists: async () => true,
			listAllMarkdownFiles: async () => ({
				files: new Map<string, RemoteFileSnapshot>([
					[
						ownDataPath,
						{
							fileId: "f-own-data",
							relativePath: ownDataPath,
							md5: computeMd5(remoteConfigBuf),
							modifiedTime: "2026-11-25T11:00:00Z",
							size: remoteConfigBuf.byteLength,
							parentId: "dir-plugin",
						},
					],
				]),
				folderIdCache: new Map(),
				warnings: [],
			}),
			ensureFolderPath: async () => "root-id",
			uploadNewFile: async () => ({ id: "id", name: "x", modifiedTime: "2026-11-25T11:00:00Z" }),
			updateFileContent: async () => ({ id: "id", name: "x", modifiedTime: "2026-11-25T11:00:00Z" }),
			downloadFile: async () => remoteConfigBuf,
			trashFile: async () => {},
		};

		const localVault: LocalVaultPort = {
			listMarkdownSnapshots: async () => ({ files: new Map(), warnings: [] }),
			readFileBinary: async () => new ArrayBuffer(0),
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
			exists: async () => false,
		};

		const onOwnConfigUpdated = vi.fn(async () => {});

		const engine = new SyncEngine({
			getSettings: () => settings,
			saveSettings: async () => {},
			storage,
			tokenProvider: { getValidAccessToken: async () => "tok" },
			drive,
			localVault,
			onOwnConfigUpdated,
		});

		await engine.runSync("manual");
		expect(onOwnConfigUpdated).toHaveBeenCalledTimes(1);
	});
});
