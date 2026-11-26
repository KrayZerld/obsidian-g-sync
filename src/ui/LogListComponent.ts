import { Setting, setIcon } from "obsidian";
import { MAX_LOG_ENTRIES } from "../constants";
import { shortenDisplayPath } from "../sync/HashUtil";
import type {
	LogLevel,
	SyncLogDetail,
	SyncLogEntry,
	SyncSummaryCounts,
	SyncTrigger,
} from "../types";

const TRIGGER_LABELS: Record<SyncTrigger, string> = {
	startup: "Start",
	interval: "Auto",
	save: "Save",
	manual: "Manual",
	init: "Init",
	system: "Sys",
};

const LEVEL_LABELS: Record<LogLevel, string> = {
	info: "Info",
	success: "Success",
	warn: "Warn",
	error: "Error",
};

function formatTimestamp(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Normalizes both newly written and legacy historical log detail messages into concise English labels.
 */
export function formatLogDetailMessage(detail: SyncLogDetail): string {
	const msg = detail.message ?? "";

	if (detail.level === "error") {
		if (msg.startsWith("Error: ")) return msg;
		const stripped = msg.replace(/^处理失败[：:]\s*/, "");
		return `Error: ${stripped}`;
	}

	if (detail.action === "upload_new" || detail.action === "upload_update") {
		if (detail.level === "success") return "Upload";
	}
	if (detail.action === "download_new" || detail.action === "download_update") {
		if (detail.level === "success") return "Download";
	}
	if (
		detail.action === "delete_remote" ||
		detail.action === "delete_local" ||
		detail.action === "remove_baseline"
	) {
		return "Delete";
	}
	if (detail.action === "resolve_conflict") {
		if (msg.startsWith("Conflict: ")) return msg;
		const legacyMatch = msg.match(/冲突副本\s*"([^"]+)"/);
		if (legacyMatch && legacyMatch[1]) {
			return `Conflict: ${shortenDisplayPath(legacyMatch[1])}`;
		}
		const stripped = msg.replace(/^检测到双端冲突[：:]\s*/, "");
		return `Conflict: ${stripped}`;
	}

	// Fallback text-based normalization for legacy logs lacking strict action/level alignment
	if (msg.startsWith("已上传")) return "Upload";
	if (msg.startsWith("已从云端下载") || msg.startsWith("已从云端更新")) return "Download";
	if (msg.startsWith("本地已删除") || msg.startsWith("云端已删除")) return "Delete";
	if (msg.startsWith("处理失败")) {
		return `Error: ${msg.replace(/^处理失败[：:]\s*/, "")}`;
	}
	if (msg.startsWith("检测到双端冲突")) {
		const legacyMatch = msg.match(/冲突副本\s*"([^"]+)"/);
		if (legacyMatch && legacyMatch[1]) {
			return `Conflict: ${shortenDisplayPath(legacyMatch[1])}`;
		}
		return `Conflict: ${msg.replace(/^检测到双端冲突[：:]\s*/, "")}`;
	}

	return msg;
}

export interface LogListComponentCallbacks {
	onResetBaseline: () => void;
	onClearLogs: () => void | Promise<void>;
}

export class LogListComponent {
	private readonly containerEl: HTMLElement;
	private readonly callbacks: LogListComponentCallbacks;
	private listEl: HTMLElement | null = null;
	private expandedIds = new Set<string>();

	constructor(containerEl: HTMLElement, callbacks: LogListComponentCallbacks) {
		this.containerEl = containerEl;
		this.callbacks = callbacks;
	}

	render(logs: SyncLogEntry[], isSyncing: boolean): void {
		this.containerEl.empty();

		const groupEl = this.containerEl.createDiv({ cls: "setting-group" });

		// Native Obsidian 1.11+ heading row with ExtraButtons
		const headingSetting = new Setting(groupEl)
			.setName("同步记录")
			.setHeading()
			.addExtraButton((btn) => {
				btn
					.setIcon("rotate-ccw")
					.setTooltip("重置基线")
					.setDisabled(isSyncing)
					.onClick(() => {
						this.callbacks.onResetBaseline();
					});
			})
			.addExtraButton((btn) => {
				btn
					.setIcon("trash-2")
					.setTooltip("清空日志")
					.setDisabled(logs.length === 0)
					.onClick(() => {
						void this.callbacks.onClearLogs();
					});
			});

		headingSetting.nameEl.createSpan({
			text: `${logs.length}/${MAX_LOG_ENTRIES}`,
			cls: "gsync-heading-meta",
		});

		this.listEl = groupEl.createDiv({ cls: "setting-items gsync-log-list" });
		this.renderEntries(logs);
	}

	private renderEntries(logs: SyncLogEntry[]): void {
		if (!this.listEl) return;
		this.listEl.empty();

		if (logs.length === 0) {
			this.listEl.createDiv({
				cls: "gsync-log-empty",
				text: "暂无同步记录。完成授权并执行同步后，每次同步详情将按时间倒序展示在此。",
			});
			return;
		}

		for (const entry of logs) {
			const hasDetails = entry.details && entry.details.length > 0;
			const isExpanded = hasDetails && this.expandedIds.has(entry.id);

			const itemEl = this.listEl.createDiv({
				cls: `gsync-log-item${isExpanded ? " is-expanded" : ""}`,
			});

			const headerEl = itemEl.createDiv({
				cls: `gsync-log-header${hasDetails ? " is-clickable" : ""}`,
			});

			const chevronWrap = headerEl.createSpan({ cls: "gsync-log-chevron" });
			if (hasDetails) {
				setIcon(chevronWrap, "chevron-right");
			}

			headerEl.createSpan({
				cls: "gsync-log-time",
				text: formatTimestamp(entry.timestamp),
			});

			headerEl.createSpan({
				cls: "gsync-badge gsync-badge-trigger",
				text: TRIGGER_LABELS[entry.trigger] ?? entry.trigger,
			});

			headerEl.createSpan({
				cls: `gsync-badge gsync-badge-level is-${entry.level}`,
				text: LEVEL_LABELS[entry.level] ?? entry.level,
			});

			const summaryWrap = headerEl.createSpan({ cls: "gsync-log-summary" });
			if (entry.counts) {
				this.renderCountsSummary(summaryWrap, entry.counts);
			} else {
				summaryWrap.setText(entry.summaryText);
			}

			if (entry.durationMs !== undefined) {
				headerEl.createSpan({
					cls: "gsync-log-duration",
					text: formatDuration(entry.durationMs),
				});
			}

			if (hasDetails) {
				const detailsEl = itemEl.createDiv({ cls: "gsync-log-details" });
				if (!isExpanded) {
					detailsEl.addClass("is-hidden");
				}

				for (const detail of entry.details) {
					const rowEl = detailsEl.createDiv({
						cls: `gsync-log-detail-row is-${detail.level}`,
					});
					rowEl.createSpan({
						cls: `gsync-detail-dot is-${detail.level}`,
					});
					if (detail.path) {
						const shortPath = shortenDisplayPath(detail.path);
						rowEl.createEl("code", {
							cls: "gsync-detail-path",
							text: shortPath,
							attr: {
								"aria-label": detail.path,
							},
						});
					}
					rowEl.createSpan({
						cls: "gsync-detail-msg",
						text: formatLogDetailMessage(detail),
					});
				}

				headerEl.addEventListener("click", () => {
					if (this.expandedIds.has(entry.id)) {
						this.expandedIds.delete(entry.id);
						itemEl.removeClass("is-expanded");
						detailsEl.addClass("is-hidden");
					} else {
						this.expandedIds.add(entry.id);
						itemEl.addClass("is-expanded");
						detailsEl.removeClass("is-hidden");
					}
				});
			}
		}
	}

	private renderCountsSummary(parent: HTMLElement, counts: SyncSummaryCounts): void {
		const bar = parent.createSpan({ cls: "gsync-log-counts" });
		const totalDeletes = counts.deletedLocal + counts.deletedRemote;

		const appendMetric = (
			iconName: string,
			value: number,
			label: string,
			extraCls?: string
		) => {
			const item = bar.createSpan({
				cls: `gsync-count-item${value === 0 ? " is-zero" : ""}${extraCls ? ` ${extraCls}` : ""}`,
				attr: { "aria-label": `${label}: ${value}` },
			});
			const iconEl = item.createSpan({ cls: "gsync-count-icon" });
			setIcon(iconEl, iconName);
			item.createSpan({ cls: "gsync-count-num", text: String(value) });
		};

		const appendSep = () => {
			bar.createSpan({ cls: "gsync-count-sep", text: "|" });
		};

		appendMetric("arrow-up", counts.uploaded, "Upload");
		appendSep();
		appendMetric("arrow-down", counts.downloaded, "Download");
		appendSep();
		appendMetric("trash-2", totalDeletes, "Delete");
		appendSep();
		appendMetric(
			"alert-triangle",
			counts.conflicts,
			"Conflict",
			counts.conflicts > 0 ? "is-conflict" : undefined
		);

		if (counts.errors > 0) {
			appendSep();
			appendMetric("x-circle", counts.errors, "Error", "is-error");
		}
	}
}
