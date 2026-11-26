import type {
	BaselineEntry,
	DiffPlanItem,
	DiffResult,
	LocalFileSnapshot,
	RemoteFileSnapshot,
	SyncLogDetail,
} from "../types";
import type { IgnoreMatcher } from "./IgnoreMatcher";

export interface ThreeWayDiffInput {
	localFiles: Map<string, LocalFileSnapshot>;
	remoteFiles: Map<string, RemoteFileSnapshot>;
	baselineFiles: Record<string, BaselineEntry>;
	isInitialSync: boolean;
	ignoreMatcher?: IgnoreMatcher;
}

function detectCaseCollisions(
	localFiles: Map<string, LocalFileSnapshot>,
	remoteFiles: Map<string, RemoteFileSnapshot>,
	baselineFiles: Record<string, BaselineEntry>
): { skippedPaths: Set<string>; warnings: SyncLogDetail[] } {
	const groups = new Map<string, Set<string>>();

	const addPath = (p: string) => {
		const key = p.toLowerCase();
		let set = groups.get(key);
		if (!set) {
			set = new Set<string>();
			groups.set(key, set);
		}
		set.add(p);
	};

	for (const p of localFiles.keys()) addPath(p);
	for (const p of remoteFiles.keys()) addPath(p);

	const skippedPaths = new Set<string>();
	const warnings: SyncLogDetail[] = [];

	for (const pathsSet of groups.values()) {
		if (pathsSet.size <= 1) continue;
		const variants = Array.from(pathsSet).sort((a, b) => a.localeCompare(b));
		// Prefer the path already tracked in Baseline, then one present locally, else lexicographically first
		const primary =
			variants.find((p) => Boolean(baselineFiles[p])) ??
			variants.find((p) => localFiles.has(p)) ??
			variants[0];

		for (const variant of variants) {
			if (variant === primary) continue;
			skippedPaths.add(variant);
			warnings.push({
				path: variant,
				action: "case_collision",
				level: "warn",
				message: `检测到仅大小写不同的路径冲突（"${variant}" 与 "${primary}"），为防止大小写不敏感文件系统覆盖，已跳过 "${variant}"。`,
			});
		}
	}

	return { skippedPaths, warnings };
}

export function computeSyncPlan(input: ThreeWayDiffInput): DiffResult {
	const { ignoreMatcher, isInitialSync } = input;
	const isIgnored = (p: string) => (ignoreMatcher ? ignoreMatcher.isIgnored(p, false) : false);

	const localFiltered = new Map<string, LocalFileSnapshot>();
	for (const [path, snap] of input.localFiles.entries()) {
		if (!isIgnored(path)) {
			localFiltered.set(path, snap);
		}
	}

	const remoteFiltered = new Map<string, RemoteFileSnapshot>();
	for (const [path, snap] of input.remoteFiles.entries()) {
		if (!isIgnored(path)) {
			remoteFiltered.set(path, snap);
		}
	}

	const baselineFiltered: Record<string, BaselineEntry> = {};
	for (const [path, entry] of Object.entries(input.baselineFiles)) {
		if (!isIgnored(path)) {
			baselineFiltered[path] = entry;
		}
	}

	const { skippedPaths, warnings } = detectCaseCollisions(
		localFiltered,
		remoteFiltered,
		baselineFiltered
	);

	const allPathsSet = new Set<string>();
	for (const p of localFiltered.keys()) allPathsSet.add(p);
	for (const p of remoteFiltered.keys()) allPathsSet.add(p);
	if (!isInitialSync) {
		for (const p of Object.keys(baselineFiltered)) allPathsSet.add(p);
	}

	const allPaths = Array.from(allPathsSet)
		.filter((p) => !skippedPaths.has(p))
		.sort((a, b) => a.localeCompare(b));

	const items: DiffPlanItem[] = [];

	for (const relativePath of allPaths) {
		const local = localFiltered.get(relativePath);
		const remote = remoteFiltered.get(relativePath);
		const baseline = isInitialSync ? undefined : baselineFiltered[relativePath];

		if (isInitialSync) {
			if (local && !remote) {
				items.push({ relativePath, action: "upload_new", scenario: "INIT_LOCAL_ONLY", local });
			} else if (!local && remote) {
				items.push({ relativePath, action: "download_new", scenario: "INIT_REMOTE_ONLY", remote });
			} else if (local && remote) {
				if (local.md5 === remote.md5) {
					items.push({
						relativePath,
						action: "record_baseline",
						scenario: "INIT_SAME",
						local,
						remote,
					});
				} else {
					items.push({
						relativePath,
						action: "resolve_conflict",
						scenario: "INIT_CONFLICT",
						local,
						remote,
					});
				}
			}
			continue;
		}

		// Three-way diff decision matrix (Scenarios 1 - 12)
		if (!baseline) {
			if (local && !remote) {
				// Scenario 2: Baseline absent, Local added, Remote absent -> Upload
				items.push({ relativePath, action: "upload_new", scenario: "S2", local });
			} else if (!local && remote) {
				// Scenario 3: Baseline absent, Local absent, Remote added -> Download
				items.push({ relativePath, action: "download_new", scenario: "S3", remote });
			} else if (local && remote) {
				// Scenario 4: Baseline absent, both added
				if (local.md5 === remote.md5) {
					items.push({
						relativePath,
						action: "record_baseline",
						scenario: "S4_SAME",
						local,
						remote,
					});
				} else {
					items.push({
						relativePath,
						action: "resolve_conflict",
						scenario: "S4_CONFLICT",
						local,
						remote,
					});
				}
			}
			continue;
		}

		const localState = !local ? "deleted" : local.md5 === baseline.md5 ? "unchanged" : "modified";
		const remoteState = !remote ? "deleted" : remote.md5 === baseline.md5 ? "unchanged" : "modified";

		if (localState === "unchanged" && remoteState === "unchanged") {
			// Scenario 1
			items.push({ relativePath, action: "noop", scenario: "S1", local, remote, baseline });
		} else if (localState === "modified" && remoteState === "unchanged") {
			// Scenario 5: Update existing remote fileId
			items.push({
				relativePath,
				action: "upload_update",
				scenario: "S5",
				local,
				remote,
				baseline,
			});
		} else if (localState === "unchanged" && remoteState === "modified") {
			// Scenario 6: Update local file
			items.push({
				relativePath,
				action: "download_update",
				scenario: "S6",
				local,
				remote,
				baseline,
			});
		} else if (localState === "modified" && remoteState === "modified") {
			// Scenario 7: Both modified
			if (local!.md5 === remote!.md5) {
				items.push({
					relativePath,
					action: "record_baseline",
					scenario: "S7_SAME",
					local,
					remote,
					baseline,
				});
			} else {
				items.push({
					relativePath,
					action: "resolve_conflict",
					scenario: "S7_CONFLICT",
					local,
					remote,
					baseline,
				});
			}
		} else if (localState === "deleted" && remoteState === "unchanged") {
			// Scenario 8: Local deleted, Remote unchanged -> Move remote to Drive Trash
			items.push({
				relativePath,
				action: "delete_remote",
				scenario: "S8",
				remote,
				baseline,
			});
		} else if (localState === "unchanged" && remoteState === "deleted") {
			// Scenario 9: Local unchanged, Remote deleted -> Move local to Obsidian Trash
			items.push({
				relativePath,
				action: "delete_local",
				scenario: "S9",
				local,
				baseline,
			});
		} else if (localState === "deleted" && remoteState === "deleted") {
			// Scenario 10: Both deleted -> Remove from baseline
			items.push({
				relativePath,
				action: "remove_baseline",
				scenario: "S10",
				baseline,
			});
		} else if (localState === "modified" && remoteState === "deleted") {
			// Scenario 11: Local modified, Remote deleted -> Protection priority: re-upload local
			items.push({
				relativePath,
				action: "upload_new",
				scenario: "S11",
				local,
				baseline,
				warning: `文件 "${relativePath}" 在本地已修改但远端已删除，按保护优先策略重新上传至云端。`,
			});
		} else if (localState === "deleted" && remoteState === "modified") {
			// Scenario 12: Local deleted, Remote modified -> Protection priority: re-download remote
			items.push({
				relativePath,
				action: "download_new",
				scenario: "S12",
				remote,
				baseline,
				warning: `文件 "${relativePath}" 在本地已删除但远端有新修改，按保护优先策略重新下载至本地。`,
			});
		}
	}

	return { items, warnings };
}
