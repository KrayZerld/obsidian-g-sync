import { describe, expect, it } from "vitest";
import { shortenDisplayPath } from "../src/sync/HashUtil";
import { formatLogDetailMessage } from "../src/ui/LogListComponent";
import { formatStatusBarTooltip } from "../src/ui/StatusBarWidget";

describe("UI formatting helpers — paths, log details, and status bar tooltip", () => {
	it("shortens nested display paths to .../<parent>/<filename> while preserving shallow paths", () => {
		expect(shortenDisplayPath("note.md")).toBe("note.md");
		expect(shortenDisplayPath("02/xxxx.md")).toBe("02/xxxx.md");
		expect(shortenDisplayPath("Projects/02/xxxx.md")).toBe(".../02/xxxx.md");
		expect(shortenDisplayPath("A/B/C/02/xxxx.md")).toBe(".../02/xxxx.md");
		expect(shortenDisplayPath("Vault\\Deep\\02\\xxxx.md")).toBe(".../02/xxxx.md");
	});

	it("simplifies both new and legacy Chinese log detail messages", () => {
		expect(
			formatLogDetailMessage({
				path: "a/b/c.md",
				action: "upload_new",
				level: "success",
				message: "已上传新文件至云端（fileId: abc123）",
			})
		).toBe("Upload");

		expect(
			formatLogDetailMessage({
				path: "a/b/c.md",
				action: "upload_update",
				level: "success",
				message: "Upload",
			})
		).toBe("Upload");

		expect(
			formatLogDetailMessage({
				path: "a/b/c.md",
				action: "download_new",
				level: "success",
				message: "已从云端下载新文件至本地",
			})
		).toBe("Download");

		expect(
			formatLogDetailMessage({
				path: "a/b/c.md",
				action: "delete_remote",
				level: "info",
				message: "本地已删除，已将云端文件移入 Google Drive 回收站",
			})
		).toBe("Delete");

		expect(
			formatLogDetailMessage({
				path: "a/b/c.md",
				action: "delete_local",
				level: "info",
				message: "Delete",
			})
		).toBe("Delete");

		expect(
			formatLogDetailMessage({
				path: "a/b/c.md",
				action: "upload_new",
				level: "error",
				message: "处理失败：HTTP 503",
			})
		).toBe("Error: HTTP 503");

		expect(
			formatLogDetailMessage({
				path: "A/02/note.md",
				action: "resolve_conflict",
				level: "warn",
				message:
					'检测到双端冲突：已将本地修改另存并上传为冲突副本 "A/02/note.conflict-PC-20261124-211500.md"，原文件已更新为云端内容，请手动合并。',
			})
		).toBe("Conflict: .../02/note.conflict-PC-20261124-211500.md");
	});

	it("formats concise English status bar hover tooltips across all states", () => {
		expect(formatStatusBarTooltip({ kind: "idle" })).toBe("Ready");
		expect(formatStatusBarTooltip({ kind: "idle", lastSyncAt: "2026-11-25T12:00:00Z" })).toBe(
			"Synced"
		);
		expect(formatStatusBarTooltip({ kind: "syncing", phase: "1/3 .../02/note.md" })).toBe(
			"Syncing: 1/3 .../02/note.md"
		);
		expect(formatStatusBarTooltip({ kind: "syncing" })).toBe("Syncing...");
		expect(formatStatusBarTooltip({ kind: "error", lastError: "Network timeout" })).toBe(
			"Error: Network timeout"
		);
		expect(formatStatusBarTooltip({ kind: "unauthenticated" })).toBe("Unauthorized");
	});
});
