import { describe, expect, it } from "vitest";
import { computeSyncPlan } from "../src/sync/ThreeWayDiff";
import { IgnoreMatcher } from "../src/sync/IgnoreMatcher";
import type { BaselineEntry, LocalFileSnapshot, RemoteFileSnapshot } from "../src/types";

function makeLocal(path: string, md5: string, mtime = 1000, size = 10): LocalFileSnapshot {
	return { relativePath: path, md5, mtime, size };
}

function makeRemote(
	path: string,
	md5: string,
	fileId = "fid-1",
	modifiedTime = "2026-11-24T12:00:00.000Z"
): RemoteFileSnapshot {
	return {
		fileId,
		relativePath: path,
		md5,
		modifiedTime,
		size: 10,
		parentId: "root-folder",
	};
}

function makeBase(md5: string, fileId = "fid-1"): BaselineEntry {
	return {
		fileId,
		md5,
		localMtime: 1000,
		remoteMtime: "2026-11-24T12:00:00.000Z",
		size: 10,
	};
}

describe("ThreeWayDiff — 12-scenario decision matrix", () => {
	it("covers all 12 three-way diff scenarios accurately", () => {
		const localFiles = new Map<string, LocalFileSnapshot>([
			["s01-unchanged.md", makeLocal("s01-unchanged.md", "aaa")],
			["s02-local-add.md", makeLocal("s02-local-add.md", "bbb")],
			// s03 absent locally
			["s04a-both-add-same.md", makeLocal("s04a-both-add-same.md", "ddd")],
			["s04b-both-add-diff.md", makeLocal("s04b-both-add-diff.md", "eee-local")],
			["s05-local-mod.md", makeLocal("s05-local-mod.md", "fff-new")],
			["s06-remote-mod.md", makeLocal("s06-remote-mod.md", "ggg-old")],
			["s07a-both-mod-same.md", makeLocal("s07a-both-mod-same.md", "hhh-same")],
			["s07b-both-mod-diff.md", makeLocal("s07b-both-mod-diff.md", "iii-local")],
			// s08 deleted locally
			["s09-remote-del.md", makeLocal("s09-remote-del.md", "kkk")],
			// s10 deleted both
			["s11-local-mod-remote-del.md", makeLocal("s11-local-mod-remote-del.md", "mmm-new")],
			// s12 deleted locally, modified remotely
		]);

		const remoteFiles = new Map<string, RemoteFileSnapshot>([
			["s01-unchanged.md", makeRemote("s01-unchanged.md", "aaa", "f1")],
			// s02 absent remotely
			["s03-remote-add.md", makeRemote("s03-remote-add.md", "ccc", "f3")],
			["s04a-both-add-same.md", makeRemote("s04a-both-add-same.md", "ddd", "f4a")],
			["s04b-both-add-diff.md", makeRemote("s04b-both-add-diff.md", "eee-remote", "f4b")],
			["s05-local-mod.md", makeRemote("s05-local-mod.md", "fff-old", "f5")],
			["s06-remote-mod.md", makeRemote("s06-remote-mod.md", "ggg-new", "f6")],
			["s07a-both-mod-same.md", makeRemote("s07a-both-mod-same.md", "hhh-same", "f7a")],
			["s07b-both-mod-diff.md", makeRemote("s07b-both-mod-diff.md", "iii-remote", "f7b")],
			["s08-local-del.md", makeRemote("s08-local-del.md", "jjj", "f8")],
			// s09 deleted remotely
			// s10 deleted both
			// s11 deleted remotely
			["s12-local-del-remote-mod.md", makeRemote("s12-local-del-remote-mod.md", "nnn-new", "f12")],
		]);

		const baselineFiles: Record<string, BaselineEntry> = {
			"s01-unchanged.md": makeBase("aaa", "f1"),
			"s05-local-mod.md": makeBase("fff-old", "f5"),
			"s06-remote-mod.md": makeBase("ggg-old", "f6"),
			"s07a-both-mod-same.md": makeBase("hhh-old", "f7a"),
			"s07b-both-mod-diff.md": makeBase("iii-old", "f7b"),
			"s08-local-del.md": makeBase("jjj", "f8"),
			"s09-remote-del.md": makeBase("kkk", "f9"),
			"s10-both-del.md": makeBase("lll", "f10"),
			"s11-local-mod-remote-del.md": makeBase("mmm-old", "f11"),
			"s12-local-del-remote-mod.md": makeBase("nnn-old", "f12"),
		};

		const result = computeSyncPlan({
			localFiles,
			remoteFiles,
			baselineFiles,
			isInitialSync: false,
		});

		const byPath = new Map(result.items.map((it) => [it.relativePath, it]));

		expect(byPath.get("s01-unchanged.md")).toMatchObject({ action: "noop", scenario: "S1" });
		expect(byPath.get("s02-local-add.md")).toMatchObject({ action: "upload_new", scenario: "S2" });
		expect(byPath.get("s03-remote-add.md")).toMatchObject({ action: "download_new", scenario: "S3" });
		expect(byPath.get("s04a-both-add-same.md")).toMatchObject({
			action: "record_baseline",
			scenario: "S4_SAME",
		});
		expect(byPath.get("s04b-both-add-diff.md")).toMatchObject({
			action: "resolve_conflict",
			scenario: "S4_CONFLICT",
		});
		expect(byPath.get("s05-local-mod.md")).toMatchObject({
			action: "upload_update",
			scenario: "S5",
		});
		expect(byPath.get("s06-remote-mod.md")).toMatchObject({
			action: "download_update",
			scenario: "S6",
		});
		expect(byPath.get("s07a-both-mod-same.md")).toMatchObject({
			action: "record_baseline",
			scenario: "S7_SAME",
		});
		expect(byPath.get("s07b-both-mod-diff.md")).toMatchObject({
			action: "resolve_conflict",
			scenario: "S7_CONFLICT",
		});
		expect(byPath.get("s08-local-del.md")).toMatchObject({
			action: "delete_remote",
			scenario: "S8",
		});
		expect(byPath.get("s09-remote-del.md")).toMatchObject({
			action: "delete_local",
			scenario: "S9",
		});
		expect(byPath.get("s10-both-del.md")).toMatchObject({
			action: "remove_baseline",
			scenario: "S10",
		});
		expect(byPath.get("s11-local-mod-remote-del.md")).toMatchObject({
			action: "upload_new",
			scenario: "S11",
		});
		expect(byPath.get("s11-local-mod-remote-del.md")?.warning).toBeTruthy();

		expect(byPath.get("s12-local-del-remote-mod.md")).toMatchObject({
			action: "download_new",
			scenario: "S12",
		});
		expect(byPath.get("s12-local-del-remote-mod.md")?.warning).toBeTruthy();
	});

	it("never deletes anything during initial sync / post-baseline-reset merge", () => {
		const localFiles = new Map<string, LocalFileSnapshot>([
			["only-local.md", makeLocal("only-local.md", "m1")],
			["same.md", makeLocal("same.md", "m2")],
			["conflict.md", makeLocal("conflict.md", "m3-local")],
		]);
		const remoteFiles = new Map<string, RemoteFileSnapshot>([
			["only-remote.md", makeRemote("only-remote.md", "m4", "fr4")],
			["same.md", makeRemote("same.md", "m2", "fr2")],
			["conflict.md", makeRemote("conflict.md", "m3-remote", "fr3")],
		]);

		const result = computeSyncPlan({
			localFiles,
			remoteFiles,
			baselineFiles: {},
			isInitialSync: true,
		});

		const actions = result.items.map((it) => it.action);
		expect(actions).not.toContain("delete_local");
		expect(actions).not.toContain("delete_remote");

		const byPath = new Map(result.items.map((it) => [it.relativePath, it]));
		expect(byPath.get("only-local.md")?.action).toBe("upload_new");
		expect(byPath.get("only-remote.md")?.action).toBe("download_new");
		expect(byPath.get("same.md")?.action).toBe("record_baseline");
		expect(byPath.get("conflict.md")?.action).toBe("resolve_conflict");
	});

	it("detects case-only path collisions and warns instead of overwriting", () => {
		const localFiles = new Map<string, LocalFileSnapshot>([
			["Notes/Todo.md", makeLocal("Notes/Todo.md", "aaa")],
		]);
		const remoteFiles = new Map<string, RemoteFileSnapshot>([
			["Notes/todo.md", makeRemote("Notes/todo.md", "bbb", "f-lower")],
		]);

		const result = computeSyncPlan({
			localFiles,
			remoteFiles,
			baselineFiles: {},
			isInitialSync: true,
			ignoreMatcher: new IgnoreMatcher(""),
		});

		expect(result.warnings.length).toBe(1);
		expect(result.warnings[0].action).toBe("case_collision");
		expect(result.warnings[0].level).toBe("warn");
		expect(result.items.map((it) => it.relativePath)).toEqual(["Notes/Todo.md"]);
	});
});
