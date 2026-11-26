import { describe, expect, it } from "vitest";
import { EMPTY_FILE_MD5, createDefaultSettings } from "../src/constants";
import { buildConflictPath, computeMd5, normalizeRelativePath } from "../src/sync/HashUtil";
import { SyncEngine } from "../src/sync/SyncEngine";
import type {
	BaselineData,
	DriveClientLike,
	DriveFileMetadata,
	GSyncSettings,
	LocalFileSnapshot,
	LocalVaultPort,
	RemoteFileSnapshot,
	StoragePort,
	SyncLogEntry,
} from "../src/types";

function strToBuf(text: string): ArrayBuffer {
	const u8 = new TextEncoder().encode(text);
	return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function bufToStr(buf: ArrayBuffer): string {
	return new TextDecoder().decode(buf);
}

describe("HashUtil & Conflict naming", () => {
	it("computes standard empty-file MD5 and UTF-8 MD5 accurately", () => {
		expect(computeMd5(new ArrayBuffer(0))).toBe(EMPTY_FILE_MD5);
		expect(computeMd5("")).toBe(EMPTY_FILE_MD5);
		expect(computeMd5(strToBuf("你好 Obsidian"))).toBe(computeMd5("你好 Obsidian"));
	});

	it("normalizes Windows backslashes and redundant slashes", () => {
		expect(normalizeRelativePath("Folder\\Sub\\Note.md")).toBe("Folder/Sub/Note.md");
		expect(normalizeRelativePath("./a//b/c.md")).toBe("a/b/c.md");
	});

	it("builds conflict filename with device name & timestamp and deduplicates same-second conflicts", () => {
		const fixedDate = new Date(2026, 10, 24, 21, 5, 9); // 2026-11-24 21:05:09
		const first = buildConflictPath("Journal/daily.md", "MyPC-01", fixedDate);
		expect(first).toBe("Journal/daily.conflict-MyPC-01-20261124-210509.md");

		const second = buildConflictPath("Journal/daily.md", "MyPC-01", fixedDate, new Set([first]));
		expect(second).toBe("Journal/daily.conflict-MyPC-01-20261124-210509-1.md");

		const rootFile = buildConflictPath("readme.md", "Lab_PC", fixedDate);
		expect(rootFile).toBe("readme.conflict-Lab_PC-20261124-210509.md");
	});
});

describe("Conflict resolution end-to-end consistency", () => {
	it("saves local edit as conflict copy, overwrites original with remote, uploads conflict copy, and updates baseline for both", async () => {
		const localStore = new Map<string, ArrayBuffer>([
			["Projects/spec.md", strToBuf("LOCAL VERSION")],
		]);
		const remoteStore = new Map<string, { meta: RemoteFileSnapshot; content: ArrayBuffer }>([
			[
				"Projects/spec.md",
				{
					meta: {
						fileId: "remote-spec-id",
						relativePath: "Projects/spec.md",
						md5: computeMd5("REMOTE VERSION"),
						modifiedTime: "2026-11-24T13:00:00.000Z",
						size: 14,
						parentId: "folder-projects",
					},
					content: strToBuf("REMOTE VERSION"),
				},
			],
		]);

		let savedBaseline: BaselineData | null = {
			version: 1,
			folderId: "repo-root-id",
			updatedAt: "2026-11-24T10:00:00.000Z",
			files: {
				"Projects/spec.md": {
					fileId: "remote-spec-id",
					md5: computeMd5("OLD BASE VERSION"),
					localMtime: 1000,
					remoteMtime: "2026-11-24T10:00:00.000Z",
					size: 16,
				},
			},
		};
		const logs: SyncLogEntry[] = [];
		const notices: string[] = [];

		const settings: GSyncSettings = {
			...createDefaultSettings(),
			clientId: "cid",
			clientSecret: "csec",
			remoteRepoPath: "Obsidian-Vault",
			deviceName: "WorkLaptop",
			auth: {
				status: "authenticated",
				tokens: { accessToken: "tok", refreshToken: "ref", expiresAt: Date.now() + 3600_000 },
				remoteFolderId: "repo-root-id",
				boundRemoteRepoPath: "Obsidian-Vault",
			},
		};

		const storage: StoragePort = {
			loadSettings: async () => settings,
			saveSettings: async () => {},
			loadBaseline: async () => savedBaseline,
			saveBaseline: async (b) => {
				savedBaseline = b;
			},
			resetBaseline: async () => {
				savedBaseline = null;
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

		const uploadedCalls: Array<{ parentId: string; name: string; content: string }> = [];

		const drive: DriveClientLike = {
			getCurrentUser: async () => ({ emailAddress: "user@example.com" }),
			resolveOrCreateRepoFolder: async () => ({
				folderId: "repo-root-id",
				created: false,
				warnings: [],
			}),
			verifyFolderExists: async () => true,
			listAllMarkdownFiles: async () => ({
				files: new Map(
					Array.from(remoteStore.entries()).map(([k, v]) => [k, v.meta])
				),
				folderIdCache: new Map([["Projects", "folder-projects"]]),
				warnings: [],
			}),
			ensureFolderPath: async (_root, dir, cache) => cache.get(dir) ?? "folder-projects",
			uploadNewFile: async (parentId, name, content): Promise<DriveFileMetadata> => {
				uploadedCalls.push({ parentId, name, content: bufToStr(content) });
				return {
					id: "conflict-remote-id",
					name,
					md5Checksum: computeMd5(content),
					modifiedTime: "2026-11-24T13:05:00.000Z",
					size: String(content.byteLength),
				};
			},
			updateFileContent: async () => {
				throw new Error("should not update original remote file on conflict");
			},
			downloadFile: async (fileId) => {
				for (const item of remoteStore.values()) {
					if (item.meta.fileId === fileId) return item.content;
				}
				throw new Error("not found");
			},
			trashFile: async () => {},
		};

		const localVault: LocalVaultPort = {
			listMarkdownSnapshots: async () => {
				const files = new Map<string, LocalFileSnapshot>();
				for (const [p, buf] of localStore.entries()) {
					files.set(p, {
						relativePath: p,
						md5: computeMd5(buf),
						mtime: 2000,
						size: buf.byteLength,
					});
				}
				return { files, warnings: [] };
			},
			readFileBinary: async (p) => localStore.get(p)!,
			writeFileBinary: async (p, content) => {
				localStore.set(p, content);
				return { relativePath: p, md5: computeMd5(content), mtime: 3000, size: content.byteLength };
			},
			createFileBinary: async (p, content) => {
				localStore.set(p, content);
				return { relativePath: p, md5: computeMd5(content), mtime: 3000, size: content.byteLength };
			},
			trashFile: async (p) => {
				localStore.delete(p);
			},
			exists: async (p) => localStore.has(p),
		};

		const fixedNow = new Date(2026, 10, 24, 21, 15, 0);
		const engine = new SyncEngine({
			getSettings: () => settings,
			saveSettings: async () => {},
			storage,
			tokenProvider: { getValidAccessToken: async () => "tok" },
			drive,
			localVault,
			onNotice: (msg) => notices.push(msg),
			now: () => fixedNow,
		});

		const res = await engine.runSync("manual");
		expect(res.executed).toBe(true);

		const expectedConflictPath = "Projects/spec.conflict-WorkLaptop-20261124-211500.md";

		// 1. Original path overwritten with remote content
		expect(bufToStr(localStore.get("Projects/spec.md")!)).toBe("REMOTE VERSION");
		// 2. Local edit preserved in conflict copy
		expect(bufToStr(localStore.get(expectedConflictPath)!)).toBe("LOCAL VERSION");
		// 3. Conflict copy uploaded in same cycle
		expect(uploadedCalls).toHaveLength(1);
		expect(uploadedCalls[0]).toEqual({
			parentId: "folder-projects",
			name: "spec.conflict-WorkLaptop-20261124-211500.md",
			content: "LOCAL VERSION",
		});
		// 4. Both paths recorded in Baseline accurately
		expect(savedBaseline?.files["Projects/spec.md"]).toMatchObject({
			fileId: "remote-spec-id",
			md5: computeMd5("REMOTE VERSION"),
		});
		expect(savedBaseline?.files[expectedConflictPath]).toMatchObject({
			fileId: "conflict-remote-id",
			md5: computeMd5("LOCAL VERSION"),
		});
		// 5. Log is Warn and Notice fired
		expect(logs[0].level).toBe("warn");
		expect(logs[0].counts?.conflicts).toBe(1);
		expect(notices.some((m) => m.includes("冲突"))).toBe(true);
	});
});
