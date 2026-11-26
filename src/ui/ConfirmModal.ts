import { Modal, type App } from "obsidian";

export interface ConfirmModalOptions {
	title: string;
	message: string;
	confirmText?: string;
	cancelText?: string;
	isDanger?: boolean;
	onConfirm: () => void | Promise<void>;
}

export class ConfirmModal extends Modal {
	private readonly options: ConfirmModalOptions;

	constructor(app: App, options: ConfirmModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle(this.options.title);

		contentEl.createEl("p", {
			text: this.options.message,
			cls: "gsync-confirm-message",
		});

		const actionsEl = contentEl.createDiv({ cls: "modal-button-container" });

		const cancelBtn = actionsEl.createEl("button", {
			text: this.options.cancelText ?? "取消",
			attr: { type: "button" },
		});
		cancelBtn.addEventListener("click", () => this.close());

		const confirmBtn = actionsEl.createEl("button", {
			text: this.options.confirmText ?? "确认",
			cls: this.options.isDanger ? "mod-warning" : "mod-cta",
			attr: { type: "button" },
		});
		confirmBtn.addEventListener("click", async () => {
			confirmBtn.disabled = true;
			try {
				await this.options.onConfirm();
			} finally {
				this.close();
			}
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
