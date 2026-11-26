import type { SyncRuntimeStatus } from "../types";
import { createStatusGIcon } from "./Icons";

export function formatStatusBarTooltip(status: SyncRuntimeStatus): string {
	switch (status.kind) {
		case "syncing":
			return status.phase ? `Syncing: ${status.phase}` : "Syncing...";
		case "error":
			return `Error: ${status.lastError || "Sync failed"}`;
		case "unauthenticated":
			return "Unauthorized";
		case "idle":
		default:
			return status.lastSyncAt ? "Synced" : "Ready";
	}
}

export class StatusBarWidget {
	private readonly rootEl: HTMLElement;

	constructor(statusBarItemEl: HTMLElement, onClick: () => void) {
		this.rootEl = statusBarItemEl;
		this.rootEl.addClass("gsync-status-bar-item", "mod-clickable", "is-idle");
		this.rootEl.setAttribute("aria-label", "Ready");
		this.rootEl.setAttribute("role", "button");
		this.rootEl.tabIndex = 0;

		this.rootEl.appendChild(createStatusGIcon(15));
		this.rootEl.addEventListener("click", (evt) => {
			evt.preventDefault();
			onClick();
		});
		this.rootEl.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				onClick();
			}
		});
	}

	update(status: SyncRuntimeStatus): void {
		this.rootEl.removeClass("is-idle", "is-syncing", "is-error", "is-unauthenticated");

		switch (status.kind) {
			case "syncing":
				this.rootEl.addClass("is-syncing");
				break;
			case "error":
				this.rootEl.addClass("is-error");
				break;
			case "unauthenticated":
				this.rootEl.addClass("is-error", "is-unauthenticated");
				break;
			case "idle":
			default:
				this.rootEl.addClass("is-idle");
				break;
		}

		this.rootEl.setAttribute("aria-label", formatStatusBarTooltip(status));
	}
}
