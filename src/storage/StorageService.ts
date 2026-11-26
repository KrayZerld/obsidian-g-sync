import {
	BASELINE_FILENAME,
	DEVICE_NAME_REGEX,
	LOCAL_CONFIG_FILENAME,
	LOGS_FILENAME,
	MAX_LOG_ENTRIES,
	createDefaultSettings,
	generateDefaultDeviceName,
} from "../constants";
import type {
	BaselineData,
	GSyncSettings,
	LocalDeviceSettings,
	SharedGSyncSettings,
	StoragePort,
	SyncLogEntry,
} from "../types";

export interface FileAdapterLike {
	exists(normalizedPath: string): Promise<boolean>;
	read(normalizedPath: string): Promise<string>;
	write(normalizedPath: string, data: string): Promise<void>;
	remove(normalizedPath: string): Promise<void>;
	mkdir(normalizedPath: string): Promise<void>;
}

export interface PluginDataHost {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

function joinPosix(dir: string, file: string): string {
	const cleanDir = dir.replace(/\\/g, "/").replace(/\/+$/, "");
	return `${cleanDir}/${file}`;
}

function extractSharedSettings(settings: GSyncSettings): SharedGSyncSettings {
	return {
		clientId: settings.clientId,
		clientSecret: settings.clientSecret,
		remoteRepoPath: settings.remoteRepoPath,
		syncOnStartup: settings.syncOnStartup,
		intervalMinutes: settings.intervalMinutes,
		saveDebounceSeconds: settings.saveDebounceSeconds,
		ignoreRules: settings.ignoreRules,
		syncObsidianConfig: settings.syncObsidianConfig,
	};
}

function extractLocalDeviceSettings(settings: GSyncSettings): LocalDeviceSettings {
	return {
		deviceName: settings.deviceName,
		auth: settings.auth,
	};
}

function sanitizeSharedSettings(
	raw: Partial<SharedGSyncSettings> | null | undefined,
	defaults: GSyncSettings
): SharedGSyncSettings {
	return {
		clientId: typeof raw?.clientId === "string" ? raw.clientId.trim() : defaults.clientId,
		clientSecret:
			typeof raw?.clientSecret === "string" ? raw.clientSecret.trim() : defaults.clientSecret,
		remoteRepoPath:
			typeof raw?.remoteRepoPath === "string"
				? raw.remoteRepoPath.trim()
				: defaults.remoteRepoPath,
		syncOnStartup:
			typeof raw?.syncOnStartup === "boolean" ? raw.syncOnStartup : defaults.syncOnStartup,
		intervalMinutes:
			typeof raw?.intervalMinutes === "number" &&
			Number.isFinite(raw.intervalMinutes) &&
			raw.intervalMinutes >= 0
				? Math.floor(raw.intervalMinutes)
				: defaults.intervalMinutes,
		saveDebounceSeconds:
			typeof raw?.saveDebounceSeconds === "number" &&
			Number.isFinite(raw.saveDebounceSeconds) &&
			raw.saveDebounceSeconds >= 0
				? Math.floor(raw.saveDebounceSeconds)
				: defaults.saveDebounceSeconds,
		ignoreRules: typeof raw?.ignoreRules === "string" ? raw.ignoreRules : defaults.ignoreRules,
		syncObsidianConfig:
			typeof raw?.syncObsidianConfig === "boolean"
				? raw.syncObsidianConfig
				: defaults.syncObsidianConfig,
	};
}

function sanitizeLocalSettings(
	raw: Partial<LocalDeviceSettings> | null | undefined,
	defaults: GSyncSettings
): LocalDeviceSettings {
	const deviceName =
		typeof raw?.deviceName === "string" && DEVICE_NAME_REGEX.test(raw.deviceName.trim())
			? raw.deviceName.trim()
			: generateDefaultDeviceName();

	const auth = {
		...defaults.auth,
		...(raw?.auth ?? {}),
	};

	if (auth.status === "authenticated" && !auth.tokens?.refreshToken) {
		auth.status = "unauthenticated";
		delete auth.tokens;
	}

	return {
		deviceName,
		auth,
	};
}

export class StorageService implements StoragePort {
	private readonly host: PluginDataHost;
	private readonly adapter: FileAdapterLike;
	private readonly pluginDir: string;
	private cachedLogs: SyncLogEntry[] | null = null;

	constructor(host: PluginDataHost, adapter: FileAdapterLike, pluginDir: string) {
		this.host = host;
		this.adapter = adapter;
		this.pluginDir = pluginDir.replace(/\\/g, "/").replace(/\/+$/, "");
	}

	private get localConfigPath(): string {
		return joinPosix(this.pluginDir, LOCAL_CONFIG_FILENAME);
	}

	private get baselinePath(): string {
		return joinPosix(this.pluginDir, BASELINE_FILENAME);
	}

	private get logsPath(): string {
		return joinPosix(this.pluginDir, LOGS_FILENAME);
	}

	async loadSettings(): Promise<GSyncSettings> {
		const defaults = createDefaultSettings();
		const rawData = (await this.host.loadData()) as Partial<GSyncSettings> | null | undefined;
		const shared = sanitizeSharedSettings(rawData, defaults);

		const existingLocal = await this.readLocalConfigFile();
		const hasLegacyLocalInData = Boolean(
			rawData &&
				typeof rawData === "object" &&
				(rawData.deviceName !== undefined || rawData.auth !== undefined)
		);

		let local: LocalDeviceSettings;
		if (existingLocal) {
			local = sanitizeLocalSettings(existingLocal, defaults);
		} else if (hasLegacyLocalInData) {
			local = sanitizeLocalSettings(
				{
					deviceName: rawData?.deviceName,
					auth: rawData?.auth,
				},
				defaults
			);
		} else {
			local = sanitizeLocalSettings(null, defaults);
		}

		const merged: GSyncSettings = {
			...shared,
			...local,
		};

		// Seamlessly migrate legacy deviceName/auth out of data.json into local.json so they never sync
		if (hasLegacyLocalInData || !existingLocal) {
			try {
				await this.writeLocalConfigFile(local);
				if (hasLegacyLocalInData) {
					await this.host.saveData(shared);
				}
			} catch {
				// Non-fatal on read-only/mock hosts; will be written on next saveSettings
			}
		}

		return merged;
	}

	async saveSettings(settings: GSyncSettings): Promise<void> {
		const shared = extractSharedSettings(settings);
		const local = extractLocalDeviceSettings(settings);
		await this.host.saveData(shared);
		await this.writeLocalConfigFile(local);
	}

	/**
	 * Reloads shared settings from data.json (e.g. after remote sync updated data.json)
	 * while strictly preserving this device's local.json fields (deviceName & auth).
	 */
	async reloadSharedSettings(current: GSyncSettings): Promise<GSyncSettings> {
		const defaults = createDefaultSettings();
		const rawData = (await this.host.loadData()) as Partial<GSyncSettings> | null | undefined;
		const shared = sanitizeSharedSettings(rawData, defaults);
		return {
			...shared,
			deviceName: current.deviceName,
			auth: current.auth,
		};
	}

	async loadBaseline(): Promise<BaselineData | null> {
		try {
			if (!(await this.adapter.exists(this.baselinePath))) {
				return null;
			}
			const raw = await this.adapter.read(this.baselinePath);
			const parsed = JSON.parse(raw) as Partial<BaselineData>;
			if (
				!parsed ||
				typeof parsed !== "object" ||
				parsed.version !== 1 ||
				typeof parsed.folderId !== "string" ||
				!parsed.files ||
				typeof parsed.files !== "object"
			) {
				return null;
			}
			return {
				version: 1,
				folderId: parsed.folderId,
				updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
				files: parsed.files,
			};
		} catch {
			return null;
		}
	}

	async saveBaseline(baseline: BaselineData): Promise<void> {
		await this.ensurePluginDir();
		const payload: BaselineData = {
			version: 1,
			folderId: baseline.folderId,
			updatedAt: baseline.updatedAt || new Date().toISOString(),
			files: baseline.files,
		};
		await this.adapter.write(this.baselinePath, JSON.stringify(payload, null, 2));
	}

	async resetBaseline(): Promise<void> {
		try {
			if (await this.adapter.exists(this.baselinePath)) {
				await this.adapter.remove(this.baselinePath);
			}
		} catch {
			// Ignore removal failure if already absent
		}
	}

	async loadLogs(): Promise<SyncLogEntry[]> {
		if (this.cachedLogs !== null) {
			return [...this.cachedLogs];
		}
		try {
			if (!(await this.adapter.exists(this.logsPath))) {
				this.cachedLogs = [];
				return [];
			}
			const raw = await this.adapter.read(this.logsPath);
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) {
				this.cachedLogs = [];
				return [];
			}
			this.cachedLogs = (parsed as SyncLogEntry[]).slice(0, MAX_LOG_ENTRIES);
			return [...this.cachedLogs];
		} catch {
			this.cachedLogs = [];
			return [];
		}
	}

	async appendLog(entry: SyncLogEntry): Promise<SyncLogEntry[]> {
		const existing = await this.loadLogs();
		const next = [entry, ...existing].slice(0, MAX_LOG_ENTRIES);
		this.cachedLogs = next;
		await this.ensurePluginDir();
		await this.adapter.write(this.logsPath, JSON.stringify(next, null, 2));
		return [...next];
	}

	async clearLogs(): Promise<void> {
		this.cachedLogs = [];
		try {
			if (await this.adapter.exists(this.logsPath)) {
				await this.adapter.write(this.logsPath, "[]");
			}
		} catch {
			// Ignore if cannot clear
		}
	}

	private async readLocalConfigFile(): Promise<Partial<LocalDeviceSettings> | null> {
		try {
			if (!(await this.adapter.exists(this.localConfigPath))) {
				return null;
			}
			const raw = await this.adapter.read(this.localConfigPath);
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object") {
				return null;
			}
			return parsed as Partial<LocalDeviceSettings>;
		} catch {
			return null;
		}
	}

	private async writeLocalConfigFile(local: LocalDeviceSettings): Promise<void> {
		await this.ensurePluginDir();
		await this.adapter.write(this.localConfigPath, JSON.stringify(local, null, 2));
	}

	private async ensurePluginDir(): Promise<void> {
		if (!(await this.adapter.exists(this.pluginDir))) {
			await this.adapter.mkdir(this.pluginDir);
		}
	}
}
