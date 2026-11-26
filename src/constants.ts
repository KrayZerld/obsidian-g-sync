import os from "os";
import type { GSyncSettings } from "./types";

export const PLUGIN_ID = "obsidian-g-sync";
export const DEFAULT_CONFIG_DIR = ".obsidian";

export const BUILTIN_IGNORE_RULES: readonly string[] = [
	".obsidian/**",
	".trash/**",
	".git/**",
	".DS_Store",
	"Thumbs.db",
];

export function normalizeConfigDir(configDir?: string): string {
	const cleaned = (configDir ?? DEFAULT_CONFIG_DIR)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return cleaned || DEFAULT_CONFIG_DIR;
}

export function getBuiltinIgnoreRules(
	syncObsidianConfig = false,
	configDir = DEFAULT_CONFIG_DIR
): string[] {
	const cfg = normalizeConfigDir(configDir);
	const common = [".trash/**", ".git/**", ".DS_Store", "Thumbs.db"];

	if (!syncObsidianConfig) {
		const rules = [`${cfg}/**`, ...common];
		if (cfg !== DEFAULT_CONFIG_DIR) {
			rules.unshift(`${DEFAULT_CONFIG_DIR}/**`);
		}
		return rules;
	}

	return [
		...common,
		`${cfg}/workspace.json`,
		`${cfg}/workspace-mobile.json`,
		`${cfg}/plugins/${PLUGIN_ID}/${LOCAL_CONFIG_FILENAME}`,
		`${cfg}/plugins/${PLUGIN_ID}/${BASELINE_FILENAME}`,
		`${cfg}/plugins/${PLUGIN_ID}/${LOGS_FILENAME}`,
	];
}

export function isPathUnderConfigDir(
	relativePath: string,
	configDir = DEFAULT_CONFIG_DIR
): boolean {
	const cfg = normalizeConfigDir(configDir);
	const norm = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return norm === cfg || norm.startsWith(`${cfg}/`);
}

export function isSyncableFilePath(
	relativePath: string,
	syncObsidianConfig = false,
	configDir = DEFAULT_CONFIG_DIR
): boolean {
	if (syncObsidianConfig && isPathUnderConfigDir(relativePath, configDir)) {
		return true;
	}
	return relativePath.toLowerCase().endsWith(".md");
}

export const MAX_LOG_ENTRIES = 200;
export const OAUTH_TIMEOUT_MS = 3 * 60 * 1000;
export const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

export const MULTIPART_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MiB
export const RESUMABLE_CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB (multiple of 256 KiB)

export const MAX_HTTP_RETRIES = 3;
export const RETRY_BASE_DELAY_MS = 1000;

export const PENDING_SYNC_DELAY_MS = 1000;
export const SELF_EVENT_SUPPRESS_MS = 1500;

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 1440;

export const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/drive";

export const GOOGLE_DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
export const GOOGLE_DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

export const DEVICE_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
export const EMPTY_FILE_MD5 = "d41d8cd98f00b204e9800998ecf8427e";

export const LOCAL_CONFIG_FILENAME = "local.json";
export const BASELINE_FILENAME = "baseline.json";
export const LOGS_FILENAME = "logs.json";

export function sanitizeDeviceName(raw: string): string {
	const cleaned = raw.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned.slice(0, 48) : "";
}

export function generateDefaultDeviceName(): string {
	try {
		const host = sanitizeDeviceName(os.hostname());
		if (host) {
			return host;
		}
	} catch {
		// Fall through to random suffix
	}
	const rand = Math.random().toString(36).slice(2, 8);
	return `device-${rand}`;
}

export function createDefaultSettings(): GSyncSettings {
	return {
		clientId: "",
		clientSecret: "",
		remoteRepoPath: "",
		deviceName: generateDefaultDeviceName(),
		auth: {
			status: "unauthenticated",
		},
		syncOnStartup: true,
		intervalMinutes: 5,
		saveDebounceSeconds: 10,
		ignoreRules: "",
		syncObsidianConfig: false,
	};
}
