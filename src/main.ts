import { Notice, Plugin, TFile, type TAbstractFile } from "obsidian";
import { GoogleAuthService } from "./auth/GoogleAuthService";
import { createDefaultSettings } from "./constants";
import { GoogleDriveClient } from "./drive/GoogleDriveClient";
import { AuthenticatedHttpClient, createObsidianRawRequester } from "./drive/HttpClient";
import { StorageService } from "./storage/StorageService";
import { IgnoreMatcher } from "./sync/IgnoreMatcher";
import { LocalScanner } from "./sync/LocalScanner";
import { SyncEngine } from "./sync/SyncEngine";
import type { GSyncSettings, SyncLogEntry, SyncRuntimeStatus } from "./types";
import { GSyncSettingTab } from "./ui/SettingTab";
import { StatusBarWidget } from "./ui/StatusBarWidget";

interface ObsidianAppWithSetting {
	setting?: {
		open: () => void;
		openTabById: (id: string) => void;
	};
}

function openExternalBrowser(url: string): void {
	try {
		// Desktop Electron environment provides shell.openExternal
		const electron = require("electron") as { shell?: { openExternal?: (u: string) => Promise<void> } };
		if (electron?.shell?.openExternal) {
			void electron.shell.openExternal(url);
			return;
		}
	} catch {
		// Fallback to window.open
	}
	if (typeof window !== "undefined") {
		window.open(url, "_blank");
	}
}

export default class GSyncPlugin extends Plugin {
	settings: GSyncSettings = createDefaultSettings();

	private storage!: StorageService;
	private authService!: GoogleAuthService;
	private syncEngine!: SyncEngine;
	private statusBarWidget!: StatusBarWidget;
	private settingTab!: GSyncSettingTab;

	private intervalTimer: ReturnType<typeof setInterval> | null = null;
	private saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	get isSyncing(): boolean {
		return this.syncEngine?.isSyncing ?? false;
	}

	async onload(): Promise<void> {
		const pluginDir =
			this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;

		this.storage = new StorageService(
			{
				loadData: () => this.loadData(),
				saveData: (data) => this.saveData(data),
			},
			this.app.vault.adapter,
			pluginDir
		);

		this.settings = await this.storage.loadSettings();

		const rawRequest = createObsidianRawRequester();

		this.authService = new GoogleAuthService({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			rawRequest,
			openExternalUrl: openExternalBrowser,
		});

		const httpClient = new AuthenticatedHttpClient({
			rawRequest,
			tokenProvider: this.authService,
		});
		const driveClient = new GoogleDriveClient(httpClient);
		const configDir = this.app.vault.configDir;
		const localScanner = new LocalScanner(this.app, configDir);

		this.syncEngine = new SyncEngine({
			getSettings: () => this.settings,
			saveSettings: () => this.saveSettings(),
			storage: this.storage,
			tokenProvider: this.authService,
			drive: driveClient,
			localVault: localScanner,
			configDir,
			onStatusChange: (status) => this.handleStatusChange(status),
			onLogAppended: () => this.settingTab?.refreshDynamicState(),
			onNotice: (msg, timeout) => {
				new Notice(msg, timeout);
			},
			onOwnConfigUpdated: async () => {
				this.settings = await this.storage.reloadSharedSettings(this.settings);
				this.resetIntervalScheduler();
				this.settingTab?.refreshDynamicState();
			},
		});

		// Status bar "G" icon
		const statusBarEl = this.addStatusBarItem();
		this.statusBarWidget = new StatusBarWidget(statusBarEl, () => {
			this.openLogTab();
		});

		// Settings tab (Auth / Sync / Log)
		this.settingTab = new GSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Command Palette shortcuts
		this.addCommand({
			id: "sync-now",
			name: "立即同步",
			callback: () => {
				void this.triggerManualSync();
			},
		});

		this.addCommand({
			id: "open-sync-log",
			name: "打开同步日志",
			callback: () => {
				this.openLogTab();
			},
		});

		// Initialize status bar state based on saved settings & latest log
		const existingLogs = await this.storage.loadLogs();
		const lastSuccess = existingLogs.find((l) => l.level === "success" || l.level === "warn");
		this.syncEngine.refreshIdleStatusFromSettings();
		if (
			this.syncEngine.status.kind === "idle" &&
			lastSuccess
		) {
			this.statusBarWidget.update({
				kind: "idle",
				lastSyncAt: lastSuccess.timestamp,
			});
		}

		// Vault change listeners for save-debounce sync
		this.registerVaultSyncEvents();

		// Startup sync & interval timer after workspace layout is ready
		this.app.workspace.onLayoutReady(() => {
			this.resetIntervalScheduler();
			if (
				this.settings.syncOnStartup &&
				this.settings.auth.status === "authenticated" &&
				this.settings.remoteRepoPath.trim().length > 0
			) {
				void this.syncEngine.runSync("startup");
			}
		});
	}

	onunload(): void {
		this.clearIntervalScheduler();
		this.cancelPendingSaveDebounce();
		this.syncEngine?.dispose();
		this.authService?.abortPendingAuth();
	}

	async saveSettings(): Promise<void> {
		await this.storage.saveSettings(this.settings);
		this.syncEngine?.refreshIdleStatusFromSettings();
	}

	async updateRemoteRepoPath(newPath: string): Promise<boolean> {
		const trimmed = newPath.trim();
		const previous = this.settings.remoteRepoPath.trim();
		const changed = trimmed !== previous;

		this.settings.remoteRepoPath = trimmed;

		if (changed && (this.settings.auth.remoteFolderId || this.settings.auth.boundRemoteRepoPath)) {
			delete this.settings.auth.remoteFolderId;
			delete this.settings.auth.boundRemoteRepoPath;
			await this.storage.resetBaseline();
			await this.storage.appendLog({
				id: `${Date.now()}-repo`,
				timestamp: new Date().toISOString(),
				trigger: "system",
				level: "info",
				summaryText: `云端仓库已变更为 "${trimmed || "(空)"}"，已解绑旧目录并清空基线`,
				details: [
					{
						path: trimmed || undefined,
						action: "change_repo",
						level: "info",
						message: "已自动解绑旧 folderId 并重置本地基线，下次同步将按首次同步安全合并。",
					},
				],
			});
			new Notice("g-Sync：云端仓库路径已修改，已自动解绑旧目录并重置基线。");
		}

		await this.saveSettings();
		this.settingTab?.refreshDynamicState();
		return changed;
	}

	async startGoogleAuth(): Promise<void> {
		try {
			const authState = await this.authService.authorize();
			const who = authState.accountEmail || authState.accountName || "Google 账号";
			await this.storage.appendLog({
				id: `${Date.now()}-auth`,
				timestamp: new Date().toISOString(),
				trigger: "system",
				level: "success",
				summaryText: `已完成 Google 授权登录（${who}）`,
				details: [
					{
						action: "oauth_login",
						level: "success",
						message: `已授权绑定账号：${who}`,
					},
				],
			});
			this.syncEngine.refreshIdleStatusFromSettings();
			new Notice(`g-Sync：授权成功（${who}）`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await this.storage.appendLog({
				id: `${Date.now()}-auth-err`,
				timestamp: new Date().toISOString(),
				trigger: "system",
				level: "error",
				summaryText: `Google 授权失败：${msg}`,
				details: [
					{
						action: "oauth_login",
						level: "error",
						message: msg,
					},
				],
			});
			new Notice(`g-Sync 授权失败：${msg}`, 7000);
		}
	}

	async disconnectGoogleAuth(): Promise<void> {
		await this.authService.disconnect();
		await this.storage.appendLog({
			id: `${Date.now()}-disconnect`,
			timestamp: new Date().toISOString(),
			trigger: "system",
			level: "info",
			summaryText: "已断开 Google 账号授权（本地与云端文件均不受影响）",
			details: [
				{
					action: "oauth_disconnect",
					level: "info",
					message: "已清除本地 OAuth Token，未删除任何本地或云端笔记。",
				},
			],
		});
		this.syncEngine.refreshIdleStatusFromSettings();
		new Notice("g-Sync：已断开 Google 授权。");
	}

	async triggerManualSync(): Promise<void> {
		await this.syncEngine.runSync("manual");
	}

	async resetBaselineWithLog(): Promise<void> {
		if (this.syncEngine.isSyncing) {
			new Notice("g-Sync：当前正在同步中，请稍后再试。");
			return;
		}
		await this.storage.resetBaseline();
		await this.storage.appendLog({
			id: `${Date.now()}-reset`,
			timestamp: new Date().toISOString(),
			trigger: "system",
			level: "info",
			summaryText: "已手动重置本地同步基线",
			details: [
				{
					action: "reset_baseline",
					level: "info",
					message: "本地历史同步快照已清空，下次同步将以首次同步无损合并模式重建基线。",
				},
			],
		});
		new Notice("g-Sync：同步基线已重置，下次同步将重新安全合并。");
	}

	async loadLogs(): Promise<SyncLogEntry[]> {
		return this.storage.loadLogs();
	}

	async clearLogs(): Promise<void> {
		await this.storage.clearLogs();
		new Notice("g-Sync：历史同步日志已清空。");
	}

	openLogTab(): void {
		this.settingTab.setActiveTab("log");
		const appWithSetting = this.app as unknown as ObsidianAppWithSetting;
		if (appWithSetting.setting) {
			appWithSetting.setting.open();
			appWithSetting.setting.openTabById(this.manifest.id);
		}
	}

	resetIntervalScheduler(): void {
		this.clearIntervalScheduler();
		const minutes = this.settings.intervalMinutes;
		if (!minutes || minutes <= 0) return;

		const intervalMs = minutes * 60 * 1000;
		this.intervalTimer = setInterval(() => {
			if (
				this.settings.auth.status === "authenticated" &&
				this.settings.remoteRepoPath.trim().length > 0
			) {
				void this.syncEngine.runSync("interval");
			}
		}, intervalMs);
	}

	clearIntervalScheduler(): void {
		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
	}

	cancelPendingSaveDebounce(): void {
		if (this.saveDebounceTimer) {
			clearTimeout(this.saveDebounceTimer);
			this.saveDebounceTimer = null;
		}
	}

	private handleStatusChange(status: SyncRuntimeStatus): void {
		this.statusBarWidget?.update(status);
		this.settingTab?.refreshDynamicState();
	}

	private registerVaultSyncEvents(): void {
		const handlePathChange = (path: string) => {
			if (!path.toLowerCase().endsWith(".md")) return;
			if (this.syncEngine.isPathSuppressed(path)) return;

			const matcher = new IgnoreMatcher(this.settings.ignoreRules, {
				syncObsidianConfig: this.settings.syncObsidianConfig,
				configDir: this.app.vault.configDir,
			});
			if (matcher.isIgnored(path, false)) return;

			this.scheduleSaveSync();
		};

		const onFileEvent = (file: TAbstractFile) => {
			if (file instanceof TFile || file.path.toLowerCase().endsWith(".md")) {
				handlePathChange(file.path);
			}
		};

		this.registerEvent(this.app.vault.on("create", onFileEvent));
		this.registerEvent(this.app.vault.on("modify", onFileEvent));
		this.registerEvent(this.app.vault.on("delete", onFileEvent));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				handlePathChange(oldPath);
				handlePathChange(file.path);
			})
		);
	}

	private scheduleSaveSync(): void {
		const seconds = this.settings.saveDebounceSeconds;
		if (!seconds || seconds <= 0) return;
		if (
			this.settings.auth.status !== "authenticated" ||
			!this.settings.remoteRepoPath.trim()
		) {
			return;
		}

		this.cancelPendingSaveDebounce();
		this.saveDebounceTimer = setTimeout(() => {
			this.saveDebounceTimer = null;
			void this.syncEngine.runSync("save");
		}, seconds * 1000);
	}
}
