import { AbstractInputSuggest, TFile, TFolder, setIcon, type App } from "obsidian";
import { normalizeRelativePath } from "../sync/HashUtil";

export interface IgnorePathCandidate {
	path: string;
	kind: "folder" | "file";
}

function pathDepth(p: string): number {
	return p.split("/").length;
}

/**
 * Autocomplete suggest for Vault folders and files starting from the Vault root.
 */
export class IgnorePathSuggest extends AbstractInputSuggest<IgnorePathCandidate> {
	private readonly inputEl: HTMLInputElement;
	private readonly extraCandidates: IgnorePathCandidate[];

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		extraCandidates: IgnorePathCandidate[] = []
	) {
		super(app, inputEl);
		this.inputEl = inputEl;
		this.extraCandidates = extraCandidates;
	}

	getSuggestions(query: string): IgnorePathCandidate[] {
		const lowerQuery = query.trim().toLowerCase();
		const map = new Map<string, IgnorePathCandidate>();

		for (const af of this.app.vault.getAllLoadedFiles()) {
			if (af instanceof TFolder) {
				const norm = normalizeRelativePath(af.path);
				if (!norm) continue; // Skip Vault root itself
				map.set(`d:${norm}`, { path: norm, kind: "folder" });
			} else if (af instanceof TFile && af.extension.toLowerCase() === "md") {
				const norm = normalizeRelativePath(af.path);
				if (!norm) continue;
				map.set(`f:${norm}`, { path: norm, kind: "file" });
			}
		}

		for (const extra of this.extraCandidates) {
			const norm = normalizeRelativePath(extra.path);
			if (!norm) continue;
			const key = `${extra.kind === "folder" ? "d" : "f"}:${norm}`;
			if (!map.has(key)) {
				map.set(key, { path: norm, kind: extra.kind });
			}
		}

		const all = Array.from(map.values()).sort((a, b) => {
			// Show Vault root-level entries first, folders before files at same depth
			const depthDiff = pathDepth(a.path) - pathDepth(b.path);
			if (depthDiff !== 0) return depthDiff;
			if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
			return a.path.localeCompare(b.path);
		});

		if (!lowerQuery) {
			return all.slice(0, 60);
		}

		return all
			.filter((item) => item.path.toLowerCase().includes(lowerQuery))
			.slice(0, 60);
	}

	renderSuggestion(item: IgnorePathCandidate, el: HTMLElement): void {
		el.addClass("gsync-suggest-item");
		const iconEl = el.createSpan({ cls: "gsync-suggest-icon" });
		setIcon(iconEl, item.kind === "folder" ? "folder" : "file-text");
		el.createSpan({
			cls: "gsync-suggest-path",
			text: item.kind === "folder" ? `${item.path}/` : item.path,
		});
	}

	selectSuggestion(item: IgnorePathCandidate): void {
		this.inputEl.value = item.kind === "folder" ? `${item.path}/**` : item.path;
		this.inputEl.trigger("input");
		this.close();
	}
}
