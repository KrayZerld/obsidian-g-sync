import {
	Notice,
	PluginSettingTab,
	Setting,
	setIcon,
	type App,
	type ExtraButtonComponent,
} from "obsidian";
import {
	DEVICE_NAME_REGEX,
	MAX_INTERVAL_MINUTES,
	MIN_INTERVAL_MINUTES,
	getBuiltinIgnoreRules,
} from "../constants";
import { splitRepoPath } from "../drive/GoogleDriveClient";
import type GSyncPlugin from "../main";
import { parseUserIgnoreList, serializeUserIgnoreList } from "../sync/IgnoreMatcher";
import { AddIgnorePathModal } from "./AddIgnorePathModal";
import { ConfirmModal } from "./ConfirmModal";
import { LogListComponent } from "./LogListComponent";

export type SettingTabKey = "auth" | "sync" | "ignore" | "log";

const TAB_ITEMS: Array<{ key: SettingTabKey; label: string }> = [
	{ key: "auth", label: "Auth" },
	{ key: "sync", label: "Sync" },
	{ key: "ignore", label: "Ignore" },
	{ key: "log", label: "Log" },
];

interface DraftValues {
	clientId: string;
	clientSecret: string;
	remoteRepoPath: string;
	deviceName: string;
	intervalMinutes: string;
	saveDebounceSeconds: string;
}

export class GSyncSettingTab extends PluginSettingTab {
	private readonly plugin: GSyncPlugin;
	private activeTab: SettingTabKey = "auth";
	private secretVisible = false;
	private isAuthorizing = false;
	private drafts: DraftValues | null = null;
	private logComponent: LogListComponent | null = null;
	private manualSyncBtn: ExtraButtonComponent | null = null;
	private isOpen = false;

	constructor(app: App, plugin: GSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	setActiveTab(tab: SettingTabKey): void {
		this.activeTab = tab;
		if (this.isOpen) {
			this.display();
		}
	}

	refreshDynamicState(): void {
		if (!this.isOpen) return;
		if (this.activeTab === "log" && this.logComponent) {
			void this.renderLogsAsync();
		} else if (this.activeTab === "sync" && this.manualSyncBtn) {
			this.updateManualSyncButtonState();
		}
	}

	private ensureDrafts(): DraftValues {
		if (!this.drafts) {
			const s = this.plugin.settings;
			this.drafts = {
				clientId: s.clientId,
				clientSecret: s.clientSecret,
				remoteRepoPath: s.remoteRepoPath,
				deviceName: s.deviceName,
				intervalMinutes: s.intervalMinutes > 0 ? String(s.intervalMinutes) : "0",
				saveDebounceSeconds: s.saveDebounceSeconds > 0 ? String(s.saveDebounceSeconds) : "0",
			};
		}
		return this.drafts;
	}

	display(): void {
		this.isOpen = true;
		this.ensureDrafts();
		this.logComponent = null;
		this.manualSyncBtn = null;

		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("gsync-settings");

		// Underline Tabs (left-aligned)
		const tabBarEl = containerEl.createDiv({ cls: "gsync-tabs" });
		for (const tab of TAB_ITEMS) {
			const btn = tabBarEl.createEl("button", {
				text: tab.label,
				cls: "gsync-tab",
				attr: {
					type: "button",
					"aria-selected": String(this.activeTab === tab.key),
				},
			});
			if (this.activeTab === tab.key) {
				btn.addClass("is-active");
			}
			btn.addEventListener("click", async () => {
				if (this.activeTab !== tab.key) {
					await this.flushValidRepoDraft();
					this.activeTab = tab.key;
					this.display();
				}
			});
		}

		const panelEl = containerEl.createDiv({ cls: "gsync-tab-panel" });
		if (this.activeTab === "auth") {
			this.renderAuthTab(panelEl);
		} else if (this.activeTab === "sync") {
			this.renderSyncTab(panelEl);
		} else if (this.activeTab === "ignore") {
			this.renderIgnoreTab(panelEl);
		} else {
			this.renderLogTab(panelEl);
		}
	}

	hide(): void {
		this.isOpen = false;
		this.drafts = null;
		this.secretVisible = false;
		this.logComponent = null;
		this.manualSyncBtn = null;
	}

	private renderAuthTab(container: HTMLElement): void {
		const drafts = this.ensureDrafts();
		const settings = this.plugin.settings;

		const groupEl = container.createDiv({ cls: "setting-group" });
		new Setting(groupEl).setName("Google OAuth 与同步仓库配置").setHeading();
		const itemsEl = groupEl.createDiv({ cls: "setting-items" });

		// 1. Google OAuth Client ID
		const clientIdSetting = new Setting(itemsEl)
			.setName("Google OAuth Client ID")
			.setDesc("Google Cloud Console 中创建的「桌面应用」OAuth 2.0 客户端 ID（必填）");
		const clientIdErrEl = this.createInlineErrorEl(clientIdSetting.descEl);
		clientIdSetting.addText((text) => {
			text.inputEl.addClass("gsync-text-input");
			text
				.setPlaceholder("xxxxx.apps.googleusercontent.com")
				.setValue(drafts.clientId)
				.onChange(async (raw) => {
					const trimmed = raw.trim();
					drafts.clientId = trimmed;
					this.setInlineError(clientIdErrEl, trimmed ? "" : "Client ID 不能为空");
					settings.clientId = trimmed;
					await this.plugin.saveSettings();
				});
		});

		// 2. Google OAuth Client Secret (native Setting.addText + addExtraButton)
		const secretSetting = new Setting(itemsEl)
			.setName("Google OAuth Client Secret")
			.setDesc("对应的 OAuth 客户端密钥，默认密文隐藏");
		const secretErrEl = this.createInlineErrorEl(secretSetting.descEl);

		let secretInputEl: HTMLInputElement | null = null;
		secretSetting.addText((text) => {
			secretInputEl = text.inputEl;
			text.inputEl.addClass("gsync-text-input");
			text.inputEl.type = this.secretVisible ? "text" : "password";
			text.inputEl.autocomplete = "off";
			text
				.setPlaceholder("GOCSPX-...")
				.setValue(drafts.clientSecret)
				.onChange(async (raw) => {
					const trimmed = raw.trim();
					drafts.clientSecret = trimmed;
					this.setInlineError(secretErrEl, trimmed ? "" : "Client Secret 不能为空");
					settings.clientSecret = trimmed;
					await this.plugin.saveSettings();
				});
		});

		secretSetting.addExtraButton((btn) => {
			const syncEyeIcon = () => {
				btn
					.setIcon(this.secretVisible ? "eye-off" : "eye")
					.setTooltip(this.secretVisible ? "隐藏 Client Secret" : "查看 Client Secret");
			};
			syncEyeIcon();
			btn.onClick(() => {
				this.secretVisible = !this.secretVisible;
				if (secretInputEl) {
					secretInputEl.type = this.secretVisible ? "text" : "password";
				}
				syncEyeIcon();
			});
		});

		// 3. 云端仓库（支持多级路径，修改后自动解绑旧 folderId 与基线）
		const repoSetting = new Setting(itemsEl)
			.setName("云端仓库")
			.setDesc("Google Drive 目标同步目录名称或路径（留空禁止同步；修改路径将解绑旧目录并重建基线）");
		const repoErrEl = this.createInlineErrorEl(repoSetting.descEl);

		const validateRepo = (val: string): { valid: boolean; normalized?: string; err?: string } => {
			const trimmed = val.trim();
			if (!trimmed) {
				return { valid: false, err: "留空时将禁止发起同步" };
			}
			try {
				const segments = splitRepoPath(trimmed);
				return { valid: true, normalized: segments.join("/") };
			} catch (e) {
				return { valid: false, err: e instanceof Error ? e.message : "路径格式无效" };
			}
		};

		const initialRepoCheck = validateRepo(drafts.remoteRepoPath);
		if (!initialRepoCheck.valid && drafts.remoteRepoPath.trim()) {
			this.setInlineError(repoErrEl, initialRepoCheck.err ?? "");
		}

		repoSetting.addText((text) => {
			text.inputEl.addClass("gsync-text-input");
			text
				.setPlaceholder("例如 Obsidian-Vault 或 Backups/Obsidian-Vault")
				.setValue(drafts.remoteRepoPath)
				.onChange((raw) => {
					drafts.remoteRepoPath = raw;
					const res = validateRepo(raw);
					this.setInlineError(repoErrEl, res.valid ? "" : (res.err ?? ""));
				});

			text.inputEl.addEventListener("blur", async () => {
				const trimmed = drafts.remoteRepoPath.trim();
				if (!trimmed) {
					await this.plugin.updateRemoteRepoPath("");
					this.setInlineError(repoErrEl, "留空时将禁止发起同步");
					return;
				}
				const res = validateRepo(trimmed);
				if (!res.valid || !res.normalized) {
					this.setInlineError(repoErrEl, res.err ?? "路径格式无效");
					return;
				}
				drafts.remoteRepoPath = res.normalized;
				text.setValue(res.normalized);
				this.setInlineError(repoErrEl, "");
				const changed = await this.plugin.updateRemoteRepoPath(res.normalized);
				if (changed) {
					this.display();
				}
			});
		});

		// 4. 设备名称
		const deviceSetting = new Setting(itemsEl)
			.setName("设备名称")
			.setDesc("仅保存在本机 local.json（不同步至云端），用于日志与冲突副本标识（仅允许字母、数字、-、_）");
		const deviceErrEl = this.createInlineErrorEl(deviceSetting.descEl);

		const validateDevice = (val: string): string => {
			const trimmed = val.trim();
			if (!trimmed) return "设备名称不能为空";
			if (!DEVICE_NAME_REGEX.test(trimmed)) return "仅允许字母、数字、连字符 (-) 和下划线 (_)";
			return "";
		};

		const initDeviceErr = validateDevice(drafts.deviceName);
		if (initDeviceErr) {
			this.setInlineError(deviceErrEl, initDeviceErr);
		}

		deviceSetting.addText((text) => {
			text.inputEl.addClass("gsync-text-input");
			text
				.setPlaceholder("My-Workstation")
				.setValue(drafts.deviceName)
				.onChange(async (raw) => {
					drafts.deviceName = raw;
					const err = validateDevice(raw);
					this.setInlineError(deviceErrEl, err);
					if (!err) {
						settings.deviceName = raw.trim();
						await this.plugin.saveSettings();
					}
				});
		});

		// 5. 授权状态与操作区
		const authGroupEl = container.createDiv({ cls: "setting-group" });
		new Setting(authGroupEl).setName("Google 账号授权状态").setHeading();
		const authItemsEl = authGroupEl.createDiv({ cls: "setting-items" });

		const auth = settings.auth;
		const isAuthed = auth.status === "authenticated" && Boolean(auth.tokens?.refreshToken);
		const isExpired = auth.status === "expired";

		let statusName = "未授权";
		let statusDesc = "完成 Client ID 与 Secret 配置后点击右侧按钮，在浏览器中授予 Google Drive 读写权限。";
		if (isAuthed) {
			const identity = auth.accountEmail
				? auth.accountName
					? `${auth.accountName} (${auth.accountEmail})`
					: auth.accountEmail
				: "已绑定 Google 账号";
			statusName = `已授权：${identity}`;
			statusDesc = auth.remoteFolderId
				? `已绑定云端目录：${auth.boundRemoteRepoPath ?? settings.remoteRepoPath}（folderId: ${auth.remoteFolderId}）`
				: "已获得离线刷新凭证，将在首次同步时自动定位或创建云端仓库目录。";
		} else if (isExpired) {
			statusName = "授权已失效";
			statusDesc = "Refresh Token 已失效或被撤销，请点击右侧按钮重新授权登录。";
		}

		const authActionSetting = new Setting(authItemsEl)
			.setName(statusName)
			.setDesc(statusDesc);

		if (isAuthed) {
			authActionSetting.nameEl.addClass("gsync-auth-ok");
			authActionSetting.addButton((btn) => {
				btn
					.setButtonText("断开授权")
					.setWarning()
					.onClick(async () => {
						await this.plugin.disconnectGoogleAuth();
						this.display();
					});
			});
		} else {
			if (isExpired) {
				authActionSetting.nameEl.addClass("gsync-auth-expired");
			}
			authActionSetting.addButton((btn) => {
				btn
					.setButtonText(this.isAuthorizing ? "等待浏览器授权..." : "授权登录")
					.setCta()
					.setDisabled(this.isAuthorizing)
					.onClick(async () => {
						const cid = drafts.clientId.trim();
						const sec = drafts.clientSecret.trim();
						this.setInlineError(clientIdErrEl, cid ? "" : "请先填写 Client ID");
						this.setInlineError(secretErrEl, sec ? "" : "请先填写 Client Secret");
						if (!cid || !sec) {
							new Notice("g-Sync：请先填写 Google OAuth Client ID 和 Client Secret。");
							return;
						}

						const trimmedRepo = drafts.remoteRepoPath.trim();
						if (trimmedRepo) {
							const check = validateRepo(trimmedRepo);
							if (check.valid && check.normalized) {
								await this.plugin.updateRemoteRepoPath(check.normalized);
							}
						}

						this.isAuthorizing = true;
						this.display();
						try {
							await this.plugin.startGoogleAuth();
						} finally {
							this.isAuthorizing = false;
							if (this.isOpen) {
								this.display();
							}
						}
					});
			});
		}
	}

	private renderSyncTab(container: HTMLElement): void {
		const drafts = this.ensureDrafts();
		const settings = this.plugin.settings;

		const groupEl = container.createDiv({ cls: "setting-group" });
		new Setting(groupEl).setName("同步触发与范围").setHeading();
		const itemsEl = groupEl.createDiv({ cls: "setting-items" });

		// 1. 启动同步
		new Setting(itemsEl)
			.setName("启动同步")
			.setDesc("Obsidian 启动并完成布局加载后，自动执行一次双向增量同步")
			.addToggle((toggle) => {
				toggle.setValue(settings.syncOnStartup).onChange(async (val) => {
					settings.syncOnStartup = val;
					await this.plugin.saveSettings();
				});
			});

		// 2. 同步 .obsidian 配置目录
		new Setting(itemsEl)
			.setName(`同步 ${this.app.vault.configDir} 配置目录`)
			.setDesc(
				"同步核心配置、外观主题、CSS 片段及第三方插件；自动强制排除本机设备名称/OAuth 授权（local.json）、基线日志与 workspace.json"
			)
			.addToggle((toggle) => {
				toggle.setValue(settings.syncObsidianConfig).onChange(async (val) => {
					settings.syncObsidianConfig = val;
					await this.plugin.saveSettings();
				});
			});

		// 3. 定时同步（分钟）
		const intervalSetting = new Setting(itemsEl)
			.setName("定时同步（分钟）")
			.setDesc(
				`每隔指定分钟自动同步一次；填 0 或留空表示关闭（正整数范围 ${MIN_INTERVAL_MINUTES} ~ ${MAX_INTERVAL_MINUTES}）`
			);
		const intervalErrEl = this.createInlineErrorEl(intervalSetting.descEl);

		const validateInterval = (raw: string): { valid: boolean; value: number; err: string } => {
			const trimmed = raw.trim();
			if (!trimmed || trimmed === "0") {
				return { valid: true, value: 0, err: "" };
			}
			if (!/^\d+$/.test(trimmed)) {
				return {
					valid: false,
					value: settings.intervalMinutes,
					err: "请输入 0 或 1 ~ 1440 之间的整数",
				};
			}
			const num = Number(trimmed);
			if (num < MIN_INTERVAL_MINUTES || num > MAX_INTERVAL_MINUTES) {
				return {
					valid: false,
					value: settings.intervalMinutes,
					err: `范围须在 ${MIN_INTERVAL_MINUTES} ~ ${MAX_INTERVAL_MINUTES} 分钟之间（或填 0 关闭）`,
				};
			}
			return { valid: true, value: num, err: "" };
		};

		const initIntCheck = validateInterval(drafts.intervalMinutes);
		if (!initIntCheck.valid) {
			this.setInlineError(intervalErrEl, initIntCheck.err);
		}

		intervalSetting.addText((text) => {
			text.inputEl.addClass("gsync-number-input");
			text.inputEl.type = "number";
			text.inputEl.min = "0";
			text.inputEl.max = String(MAX_INTERVAL_MINUTES);
			text
				.setPlaceholder("5")
				.setValue(drafts.intervalMinutes)
				.onChange(async (raw) => {
					drafts.intervalMinutes = raw;
					const res = validateInterval(raw);
					this.setInlineError(intervalErrEl, res.err);
					if (res.valid) {
						settings.intervalMinutes = res.value;
						await this.plugin.saveSettings();
						this.plugin.resetIntervalScheduler();
					}
				});
		});

		// 4. 保存同步（秒）
		const debounceSetting = new Setting(itemsEl)
			.setName("保存同步（秒）")
			.setDesc("监听 .md 文件增删改重命名事件，在连续编辑停止 N 秒后自动触发同步；填 0 或留空表示关闭");
		const debounceErrEl = this.createInlineErrorEl(debounceSetting.descEl);

		const validateDebounce = (raw: string): { valid: boolean; value: number; err: string } => {
			const trimmed = raw.trim();
			if (!trimmed || trimmed === "0") {
				return { valid: true, value: 0, err: "" };
			}
			if (!/^\d+$/.test(trimmed)) {
				return {
					valid: false,
					value: settings.saveDebounceSeconds,
					err: "请输入非负整数（秒）",
				};
			}
			const num = Number(trimmed);
			if (num > 3600) {
				return {
					valid: false,
					value: settings.saveDebounceSeconds,
					err: "防抖延迟建议不超过 3600 秒",
				};
			}
			return { valid: true, value: num, err: "" };
		};

		const initDebCheck = validateDebounce(drafts.saveDebounceSeconds);
		if (!initDebCheck.valid) {
			this.setInlineError(debounceErrEl, initDebCheck.err);
		}

		debounceSetting.addText((text) => {
			text.inputEl.addClass("gsync-number-input");
			text.inputEl.type = "number";
			text.inputEl.min = "0";
			text.inputEl.max = "3600";
			text
				.setPlaceholder("10")
				.setValue(drafts.saveDebounceSeconds)
				.onChange(async (raw) => {
					drafts.saveDebounceSeconds = raw;
					const res = validateDebounce(raw);
					this.setInlineError(debounceErrEl, res.err);
					if (res.valid) {
						settings.saveDebounceSeconds = res.value;
						await this.plugin.saveSettings();
						this.plugin.cancelPendingSaveDebounce();
					}
				});
		});

		// 5. 手动同步（原生 ExtraButton 刷新图标）
		const manualGroupEl = container.createDiv({ cls: "setting-group" });
		const manualItemsEl = manualGroupEl.createDiv({ cls: "setting-items" });

		new Setting(manualItemsEl)
			.setName("手动同步")
			.setDesc("立即与 Google Drive 执行一次双向增量同步与校验")
			.addExtraButton((btn) => {
				this.manualSyncBtn = btn;
				btn.extraSettingsEl.addClass("gsync-sync-refresh-btn");
				btn.setIcon("refresh-cw").onClick(() => {
					if (this.plugin.isSyncing) return;
					void this.plugin.triggerManualSync();
				});
				this.updateManualSyncButtonState();
			});
	}

	private renderIgnoreTab(container: HTMLElement): void {
		const settings = this.plugin.settings;
		const userRules = parseUserIgnoreList(settings.ignoreRules);
		const builtinRules = getBuiltinIgnoreRules(
			settings.syncObsidianConfig,
			this.app.vault.configDir
		);

		const groupEl = container.createDiv({ cls: "setting-group" });
		const headingSetting = new Setting(groupEl)
			.setName("忽略同步路径")
			.setHeading()
			.addExtraButton((btn) => {
				btn
					.setIcon("plus")
					.setTooltip("添加忽略路径")
					.onClick(() => {
						new AddIgnorePathModal(this.app, {
							existingRules: userRules,
							builtinRules,
							syncObsidianConfig: settings.syncObsidianConfig,
							onSubmit: async (newRule) => {
								const next = [...userRules, newRule];
								settings.ignoreRules = serializeUserIgnoreList(next);
								await this.plugin.saveSettings();
								this.display();
							},
						}).open();
					});
			});

		headingSetting.nameEl.createSpan({
			text: `${userRules.length} 自定义 · ${builtinRules.length} 内置`,
			cls: "gsync-heading-meta",
		});

		const itemsEl = groupEl.createDiv({ cls: "setting-items" });

		// 1. User-added custom ignore paths (removable via native ExtraButton)
		userRules.forEach((rule, index) => {
			const rowSetting = new Setting(itemsEl);
			rowSetting.settingEl.addClass("gsync-ignore-row");
			rowSetting.nameEl.empty();
			rowSetting.nameEl.createEl("code", {
				cls: "gsync-ignore-path",
				text: rule,
			});

			rowSetting.addExtraButton((btn) => {
				btn.extraSettingsEl.addClass("gsync-danger-icon");
				btn
					.setIcon("trash-2")
					.setTooltip("移除该忽略路径")
					.onClick(async () => {
						const next = userRules.filter((_, i) => i !== index);
						settings.ignoreRules = serializeUserIgnoreList(next);
						await this.plugin.saveSettings();
						this.display();
					});
			});
		});

		// 2. Built-in protected ignore paths (read-only lock icon)
		for (const rule of builtinRules) {
			const rowSetting = new Setting(itemsEl);
			rowSetting.settingEl.addClass("gsync-ignore-row", "is-builtin");
			rowSetting.nameEl.empty();
			rowSetting.nameEl.createEl("code", {
				cls: "gsync-ignore-path",
				text: rule,
			});

			const lockEl = rowSetting.controlEl.createSpan({
				cls: "gsync-ignore-builtin-icon",
				attr: {
					"aria-label": "内置保护规则，不可移除",
				},
			});
			setIcon(lockEl, "lock");
		}
	}

	private renderLogTab(container: HTMLElement): void {
		const logHost = container.createDiv({ cls: "gsync-log-panel" });
		this.logComponent = new LogListComponent(logHost, {
			onResetBaseline: () => {
				if (this.plugin.isSyncing) {
					new Notice("g-Sync：当前正在同步中，请稍后再试。");
					return;
				}
				new ConfirmModal(this.app, {
					title: "确认重置基线",
					message:
						"重置基线将清除本地历史同步快照，下次同步将以「首次同步」合并模式重新比对本地与云端（不会删除任何文件），确认继续吗？",
					confirmText: "确认重置",
					cancelText: "取消",
					isDanger: true,
					onConfirm: async () => {
						await this.plugin.resetBaselineWithLog();
						await this.renderLogsAsync();
					},
				}).open();
			},
			onClearLogs: async () => {
				await this.plugin.clearLogs();
				await this.renderLogsAsync();
			},
		});

		void this.renderLogsAsync();
	}

	private async renderLogsAsync(): Promise<void> {
		if (!this.logComponent) return;
		const logs = await this.plugin.loadLogs();
		if (this.isOpen && this.activeTab === "log" && this.logComponent) {
			this.logComponent.render(logs, this.plugin.isSyncing);
		}
	}

	private updateManualSyncButtonState(): void {
		if (!this.manualSyncBtn) return;
		const syncing = this.plugin.isSyncing;
		this.manualSyncBtn.setDisabled(syncing);
		this.manualSyncBtn.setTooltip(syncing ? "Syncing..." : "立即同步");
		this.manualSyncBtn.extraSettingsEl.toggleClass("is-loading", syncing);
	}

	private createInlineErrorEl(parent: HTMLElement): HTMLElement {
		return parent.createDiv({ cls: "gsync-inline-error is-hidden" });
	}

	private setInlineError(el: HTMLElement, msg: string): void {
		el.textContent = msg;
		el.toggleClass("is-hidden", !msg);
	}

	private async flushValidRepoDraft(): Promise<void> {
		if (!this.drafts) return;
		const trimmed = this.drafts.remoteRepoPath.trim();
		if (!trimmed) {
			if (this.plugin.settings.remoteRepoPath !== "") {
				await this.plugin.updateRemoteRepoPath("");
			}
			return;
		}
		try {
			const normalized = splitRepoPath(trimmed).join("/");
			this.drafts.remoteRepoPath = normalized;
			if (this.plugin.settings.remoteRepoPath !== normalized) {
				await this.plugin.updateRemoteRepoPath(normalized);
			}
		} catch {
			// Keep invalid draft in memory so inline validation persists across tab switches
		}
	}
}
