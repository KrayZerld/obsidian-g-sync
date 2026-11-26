export type AuthStatus = "unauthenticated" | "authenticated" | "expired";

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // epoch ms
}

export interface AuthState {
	status: AuthStatus;
	accountEmail?: string;
	accountName?: string;
	tokens?: AuthTokens;
	remoteFolderId?: string;
	boundRemoteRepoPath?: string;
}

export interface SharedGSyncSettings {
	clientId: string;
	clientSecret: string;
	remoteRepoPath: string;
	syncOnStartup: boolean;
	intervalMinutes: number;
	saveDebounceSeconds: number;
	ignoreRules: string;
	syncObsidianConfig: boolean;
}

export interface LocalDeviceSettings {
	deviceName: string;
	auth: AuthState;
}

export interface GSyncSettings extends SharedGSyncSettings, LocalDeviceSettings {}

export interface BaselineEntry {
	fileId: string;
	md5: string;
	localMtime: number; // epoch ms
	remoteMtime: string; // RFC 3339 ISO string
	size: number;
}

export interface BaselineData {
	version: 1;
	folderId: string;
	updatedAt: string;
	files: Record<string, BaselineEntry>;
}

export type SyncTrigger = "startup" | "interval" | "save" | "manual" | "init" | "system";

export type LogLevel = "info" | "success" | "warn" | "error";

export interface SyncSummaryCounts {
	uploaded: number;
	downloaded: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	skipped: number;
	errors: number;
}

export interface SyncLogDetail {
	path?: string;
	action: string;
	level: LogLevel;
	message: string;
}

export interface SyncLogEntry {
	id: string;
	timestamp: string; // ISO 8601
	trigger: SyncTrigger;
	level: LogLevel;
	summaryText: string;
	counts?: SyncSummaryCounts;
	durationMs?: number;
	details: SyncLogDetail[];
}

export interface LocalFileSnapshot {
	relativePath: string;
	md5: string;
	mtime: number;
	size: number;
}

export interface RemoteFileSnapshot {
	fileId: string;
	relativePath: string;
	md5: string;
	modifiedTime: string;
	size: number;
	parentId: string;
}

export type DiffActionType =
	| "noop"
	| "record_baseline"
	| "upload_new"
	| "upload_update"
	| "download_new"
	| "download_update"
	| "delete_remote"
	| "delete_local"
	| "remove_baseline"
	| "resolve_conflict";

export interface DiffPlanItem {
	relativePath: string;
	action: DiffActionType;
	scenario: string;
	local?: LocalFileSnapshot;
	remote?: RemoteFileSnapshot;
	baseline?: BaselineEntry;
	warning?: string;
}

export interface DiffResult {
	items: DiffPlanItem[];
	warnings: SyncLogDetail[];
}

export type StatusBarStateKind = "unauthenticated" | "error" | "idle" | "syncing";

export interface SyncRuntimeStatus {
	kind: StatusBarStateKind;
	phase?: string;
	lastSyncAt?: string;
	lastError?: string;
}

export interface HttpRequestOptions {
	url: string;
	method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
	throw?: boolean;
}

export interface HttpResponseData {
	status: number;
	headers: Record<string, string>;
	text: string;
	arrayBuffer: ArrayBuffer;
	json: unknown;
}

export type RawHttpRequester = (options: HttpRequestOptions) => Promise<HttpResponseData>;

export interface TokenProvider {
	getValidAccessToken(forceRefresh?: boolean): Promise<string>;
}

export interface DriveFileMetadata {
	id: string;
	name: string;
	mimeType?: string;
	md5Checksum?: string;
	modifiedTime: string;
	size?: string;
	parents?: string[];
}

export interface RemoteScanResult {
	files: Map<string, RemoteFileSnapshot>;
	folderIdCache: Map<string, string>;
	warnings: SyncLogDetail[];
}

export interface ScanScopeOptions {
	syncObsidianConfig?: boolean;
	configDir?: string;
}

export interface DriveClientLike {
	getCurrentUser(): Promise<{ emailAddress?: string; displayName?: string }>;
	resolveOrCreateRepoFolder(repoPath: string): Promise<{ folderId: string; created: boolean; warnings: SyncLogDetail[] }>;
	verifyFolderExists(folderId: string): Promise<boolean>;
	listAllMarkdownFiles(
		rootFolderId: string,
		shouldIgnorePath: (relativePath: string, isDir?: boolean) => boolean,
		baselineFiles?: Record<string, BaselineEntry>,
		scope?: ScanScopeOptions
	): Promise<RemoteScanResult>;
	ensureFolderPath(rootFolderId: string, dirPath: string, cache: Map<string, string>): Promise<string>;
	uploadNewFile(parentId: string, name: string, content: ArrayBuffer): Promise<DriveFileMetadata>;
	updateFileContent(fileId: string, content: ArrayBuffer, fileName?: string): Promise<DriveFileMetadata>;
	downloadFile(fileId: string): Promise<ArrayBuffer>;
	trashFile(fileId: string): Promise<void>;
}

export interface LocalVaultPort {
	listMarkdownSnapshots(
		shouldIgnorePath: (relativePath: string, isDir?: boolean) => boolean,
		scope?: ScanScopeOptions
	): Promise<{
		files: Map<string, LocalFileSnapshot>;
		warnings: SyncLogDetail[];
	}>;
	readFileBinary(relativePath: string): Promise<ArrayBuffer>;
	writeFileBinary(relativePath: string, content: ArrayBuffer): Promise<LocalFileSnapshot>;
	createFileBinary(relativePath: string, content: ArrayBuffer): Promise<LocalFileSnapshot>;
	trashFile(relativePath: string): Promise<void>;
	exists(relativePath: string): Promise<boolean>;
}

export interface StoragePort {
	loadSettings(): Promise<GSyncSettings>;
	saveSettings(settings: GSyncSettings): Promise<void>;
	reloadSharedSettings?(current: GSyncSettings): Promise<GSyncSettings>;
	loadBaseline(): Promise<BaselineData | null>;
	saveBaseline(baseline: BaselineData): Promise<void>;
	resetBaseline(): Promise<void>;
	loadLogs(): Promise<SyncLogEntry[]>;
	appendLog(entry: SyncLogEntry): Promise<SyncLogEntry[]>;
	clearLogs(): Promise<void>;
}

export class GSyncError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GSyncError";
	}
}

export class AuthExpiredError extends GSyncError {
	constructor(message = "Google 授权已失效，请重新登录授权。") {
		super(message);
		this.name = "AuthExpiredError";
	}
}

export class HttpError extends GSyncError {
	public readonly status: number;
	public readonly responseText: string;
	public readonly retryAfterMs?: number;

	constructor(status: number, message: string, responseText = "", retryAfterMs?: number) {
		super(message);
		this.name = "HttpError";
		this.status = status;
		this.responseText = responseText;
		this.retryAfterMs = retryAfterMs;
	}
}
