import { Modal, Setting, TFolder, type App } from "obsidian";
import { normalizeConfigDir } from "../constants";
import { normalizeRelativePath } from "../sync/HashUtil";
import { normalizeIgnoreRuleInput } from "../sync/IgnoreMatcher";
import { IgnorePathSuggest, type IgnorePathCandidate } from "./IgnorePathSuggest";

export interface AddIgnorePathModalOptions {
	existingRules: string[];
	builtinRules: string[];
	syncObsidianConfig: boolean;
	onSubmit: (rule: string) => void | Promise<void>;
}

export class AddIgnorePathModal extends Modal {
	private readonly options: AddIgnorePathModalOptions;
	private rawValue = "";
	private errorEl: HTMLElement | null = null;
	private hiddenCandidates: IgnorePathCandidate[] = [];

	constructor(app: App, options: AddIgnorePathModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("gsync-ignore-modal");
		this.setTitle("添加忽略路径");

		let inputElRef: HTMLInputElement | null = null;

		new Setting(contentEl)
			.setName("忽略路径或规则")
			.setDesc("默认从 Vault 根目录开始补全；可选择文件夹、文件或直接输入通配符（如 Private/**、*.draft.md）")
			.addText((text) => {
				text.setPlaceholder("Private/** 或 *.draft.md");
				text.inputEl.addClass("gsync-modal-input");
				inputElRef = text.inputEl;
				text.onChange((val) => {
					this.rawValue = val;
					this.clearError();
				});
				text.inputEl.addEventListener("keydown", (evt) => {
					if (evt.key === "Enter") {
						evt.preventDefault();
						void this.handleConfirm();
					}
				});

				// Preload top-level hidden configDir paths when .obsidian sync is enabled
				if (this.options.syncObsidianConfig) {
					void this.loadConfigDirCandidates().then((extras) => {
						this.hiddenCandidates = extras;
						if (inputElRef) {
							new IgnorePathSuggest(this.app, inputElRef, this.hiddenCandidates);
						}
					});
				} else {
					new IgnorePathSuggest(this.app, text.inputEl);
				}
			});

		this.errorEl = contentEl.createDiv({ cls: "gsync-modal-error" });

		const footerEl = contentEl.createDiv({ cls: "modal-button-container" });

		const cancelBtn = footerEl.createEl("button", {
			text: "取消",
			attr: { type: "button" },
		});
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = footerEl.createEl("button", {
			text: "确认",
			cls: "mod-cta",
			attr: { type: "button" },
		});
		confirmBtn.addEventListener("click", () => {
			void this.handleConfirm();
		});

		setTimeout(() => {
			inputElRef?.focus();
		}, 10);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async loadConfigDirCandidates(): Promise<IgnorePathCandidate[]> {
		const results: IgnorePathCandidate[] = [];
		const configDir = normalizeConfigDir(this.app.vault.configDir);
		try {
			if (!(await this.app.vault.adapter.exists(configDir))) {
				return results;
			}
			const top = await this.app.vault.adapter.list(configDir);
			for (const folder of top.folders) {
				const norm = normalizeRelativePath(folder);
				if (norm) results.push({ path: norm, kind: "folder" });
				// One level deeper for plugins/themes/snippets
				try {
					const sub = await this.app.vault.adapter.list(norm);
					for (const subFolder of sub.folders) {
						const subNorm = normalizeRelativePath(subFolder);
						if (subNorm) results.push({ path: subNorm, kind: "folder" });
					}
				} catch {
					// Ignore unreadable subfolder
				}
			}
			for (const file of top.files) {
				const norm = normalizeRelativePath(file);
				if (norm) results.push({ path: norm, kind: "file" });
			}
		} catch {
			// Non-fatal
		}
		return results;
	}

	private clearError(): void {
		if (this.errorEl) {
			this.errorEl.setText("");
			this.errorEl.removeClass("is-visible");
		}
	}

	private showError(message: string): void {
		if (this.errorEl) {
			this.errorEl.setText(message);
			this.errorEl.addClass("is-visible");
		}
	}

	private async handleConfirm(): Promise<void> {
		const trimmed = this.rawValue.trim();
		if (!trimmed) {
			this.showError("请输入或选择要忽略的路径或通配符规则。");
			return;
		}
		if (trimmed === "/" || trimmed === "./") {
			this.showError("不支持忽略整个 Vault 根目录，请选择具体文件夹或文件。");
			return;
		}
		if (trimmed.startsWith("#")) {
			this.showError("路径规则不能以 # 开头。");
			return;
		}

		// Detect whether user typed a bare existing folder path without trailing /** or /
		const candidateClean = normalizeRelativePath(trimmed.replace(/^!/, ""));
		const existingAbstract = candidateClean
			? this.app.vault.getAbstractFileByPath(candidateClean)
			: null;
		const isHiddenFolder = this.hiddenCandidates.some(
			(c) => c.kind === "folder" && c.path === candidateClean
		);
		const isFolder =
			!trimmed.includes("*") &&
			!trimmed.includes("?") &&
			(trimmed.endsWith("/") || existingAbstract instanceof TFolder || isHiddenFolder);

		const normalized = normalizeIgnoreRuleInput(trimmed, isFolder);
		if (!normalized) {
			this.showError("路径格式无效，请重新输入。");
			return;
		}

		if (this.options.builtinRules.includes(normalized)) {
			this.showError(`"${normalized}" 已在内置忽略清单中，无需重复添加。`);
			return;
		}
		if (this.options.existingRules.includes(normalized)) {
			this.showError(`"${normalized}" 已在忽略清单中，请勿重复添加。`);
			return;
		}

		await this.options.onSubmit(normalized);
		this.close();
	}
}
