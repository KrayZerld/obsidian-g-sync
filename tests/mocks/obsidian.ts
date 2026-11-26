export async function requestUrl(_request: unknown): Promise<{
	status: number;
	headers: Record<string, string>;
	text: string;
	arrayBuffer: ArrayBuffer;
	json: unknown;
}> {
	throw new Error("requestUrl mock should be overridden in tests");
}

export class Notice {
	public message: string;
	constructor(message: string, _timeout?: number) {
		this.message = message;
	}
}

export function setIcon(_el: HTMLElement, _iconId: string): void {}

export class Modal {
	app: unknown;
	contentEl: unknown;
	modalEl: unknown;
	constructor(app: unknown) {
		this.app = app;
	}
	setTitle(_title: string): this {
		return this;
	}
	open(): void {}
	close(): void {}
}

export class Plugin {
	app: unknown;
	manifest: unknown;
}

export class PluginSettingTab {
	app: unknown;
	plugin: unknown;
	containerEl: unknown;
	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}
}

export class Setting {
	settingEl: unknown;
	descEl: unknown;
	nameEl: unknown;
	controlEl: unknown;
	constructor(_containerEl: unknown) {}
	setName(_name: string): this {
		return this;
	}
	setDesc(_desc: string): this {
		return this;
	}
}

export class TFile {
	path = "";
	extension = "md";
	stat = { mtime: 0, size: 0, ctime: 0 };
}

export class TFolder {
	path = "";
}

export abstract class AbstractInputSuggest<T> {
	app: unknown;
	constructor(app: unknown, _inputEl: HTMLInputElement) {
		this.app = app;
	}
	close(): void {}
	abstract getSuggestions(query: string): T[];
	abstract renderSuggestion(value: T, el: HTMLElement): void;
	abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
}
