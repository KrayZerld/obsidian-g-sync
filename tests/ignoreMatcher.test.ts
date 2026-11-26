import { describe, expect, it } from "vitest";
import {
	IgnoreMatcher,
	normalizeIgnoreRuleInput,
	parseUserIgnoreList,
	serializeUserIgnoreList,
} from "../src/sync/IgnoreMatcher";
import { computeSyncPlan } from "../src/sync/ThreeWayDiff";
import type { BaselineEntry, LocalFileSnapshot, RemoteFileSnapshot } from "../src/types";

describe("IgnoreMatcher", () => {
	it("always ignores built-in protected paths even if user writes negation rules", () => {
		const matcher = new IgnoreMatcher("!.obsidian/**\n!.trash/**\n!.git/**\n!.DS_Store");

		expect(matcher.isIgnored(".obsidian/plugins/obsidian-g-sync/data.json")).toBe(true);
		expect(matcher.isIgnored(".obsidian", true)).toBe(true);
		expect(matcher.isIgnored(".trash/deleted.md")).toBe(true);
		expect(matcher.isIgnored(".git/HEAD")).toBe(true);
		expect(matcher.isIgnored(".DS_Store")).toBe(true);
		expect(matcher.isIgnored("Notes/.DS_Store")).toBe(true);
	});

	it("handles glob patterns, comments, blank lines, directory rules, and user negation", () => {
		const rules = [
			"# User custom rules",
			"",
			"Private/**",
			"*.draft.md",
			"Archive/",
			"temp-?.md",
			"!Private/public-readme.md",
		].join("\n");

		const matcher = new IgnoreMatcher(rules);

		expect(matcher.isIgnored("Private", true)).toBe(true);
		expect(matcher.isIgnored("Private/secret.md")).toBe(true);
		expect(matcher.isIgnored("Private/sub/deep.md")).toBe(true);
		expect(matcher.isIgnored("Private/public-readme.md")).toBe(false);

		expect(matcher.isIgnored("idea.draft.md")).toBe(true);
		expect(matcher.isIgnored("Folder/idea.draft.md")).toBe(true);
		expect(matcher.isIgnored("Folder/idea.md")).toBe(false);

		expect(matcher.isIgnored("Archive", true)).toBe(true);
		expect(matcher.isIgnored("Archive/2025/log.md")).toBe(true);

		expect(matcher.isIgnored("temp-1.md")).toBe(true);
		expect(matcher.isIgnored("temp-12.md")).toBe(false);
	});

	it("does not generate delete actions when a newly added ignore rule matches previously baselined files", () => {
		const matcher = new IgnoreMatcher("Private/**");
		const localFiles = new Map<string, LocalFileSnapshot>([
			["Public/ok.md", { relativePath: "Public/ok.md", md5: "aaa", mtime: 10, size: 5 }],
		]);
		const remoteFiles = new Map<string, RemoteFileSnapshot>([
			[
				"Public/ok.md",
				{
					fileId: "f1",
					relativePath: "Public/ok.md",
					md5: "aaa",
					modifiedTime: "2026-11-24T12:00:00Z",
					size: 5,
					parentId: "root",
				},
			],
			[
				"Private/diary.md",
				{
					fileId: "f-priv",
					relativePath: "Private/diary.md",
					md5: "secret",
					modifiedTime: "2026-11-24T12:00:00Z",
					size: 20,
					parentId: "p-dir",
				},
			],
		]);
		const baselineFiles: Record<string, BaselineEntry> = {
			"Public/ok.md": {
				fileId: "f1",
				md5: "aaa",
				localMtime: 10,
				remoteMtime: "2026-11-24T12:00:00Z",
				size: 5,
			},
			"Private/diary.md": {
				fileId: "f-priv",
				md5: "secret",
				localMtime: 10,
				remoteMtime: "2026-11-24T12:00:00Z",
				size: 20,
			},
		};

		const plan = computeSyncPlan({
			localFiles,
			remoteFiles,
			baselineFiles,
			isInitialSync: false,
			ignoreMatcher: matcher,
		});

		expect(plan.items.find((i) => i.relativePath === "Private/diary.md")).toBeUndefined();
		expect(plan.items).toHaveLength(1);
		expect(plan.items[0]).toMatchObject({ relativePath: "Public/ok.md", action: "noop" });
	});

	it("parses, deduplicates, serializes, and normalizes ignore item list rules cleanly", () => {
		const raw = "\n# comment\nPrivate/**\n*.draft.md\nPrivate/**\n  Archive/2025.md  \n";
		const list = parseUserIgnoreList(raw);
		expect(list).toEqual(["Private/**", "*.draft.md", "Archive/2025.md"]);
		expect(serializeUserIgnoreList([...list, "*.draft.md", "  "])).toBe(
			"Private/**\n*.draft.md\nArchive/2025.md"
		);

		expect(normalizeIgnoreRuleInput("Private", true)).toBe("Private/**");
		expect(normalizeIgnoreRuleInput("/Notes\\Archive/", true)).toBe("Notes/Archive/**");
		expect(normalizeIgnoreRuleInput("Private/**", true)).toBe("Private/**");
		expect(normalizeIgnoreRuleInput("./Notes/secret.md", false)).toBe("Notes/secret.md");
		expect(normalizeIgnoreRuleInput("*.draft.md", false)).toBe("*.draft.md");
		expect(normalizeIgnoreRuleInput("/", true)).toBe("");
		expect(normalizeIgnoreRuleInput("..", false)).toBe("");
	});
});
