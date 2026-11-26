import {
	DEFAULT_CONFIG_DIR,
	EMPTY_FILE_MD5,
	GOOGLE_DRIVE_API_BASE,
	GOOGLE_DRIVE_UPLOAD_BASE,
	GOOGLE_FOLDER_MIME,
	MULTIPART_UPLOAD_THRESHOLD_BYTES,
	RESUMABLE_CHUNK_SIZE_BYTES,
	isSyncableFilePath,
} from "../constants";
import {
	GSyncError,
	HttpError,
	type BaselineEntry,
	type DriveClientLike,
	type DriveFileMetadata,
	type RemoteFileSnapshot,
	type RemoteScanResult,
	type ScanScopeOptions,
	type SyncLogDetail,
} from "../types";
import type { AuthenticatedHttpClient } from "./HttpClient";

const FILE_FIELDS = "id,name,mimeType,md5Checksum,modifiedTime,size,parents";

export function guessContentType(fileName?: string): string {
	const lower = (fileName ?? "").toLowerCase();
	if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
	if (lower.endsWith(".json")) return "application/json; charset=utf-8";
	if (lower.endsWith(".css")) return "text/css; charset=utf-8";
	if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
		return "application/javascript; charset=utf-8";
	}
	if (lower.endsWith(".svg")) return "image/svg+xml";
	if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
	return "application/octet-stream";
}

export function escapeDriveQueryValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function splitRepoPath(repoPath: string): string[] {
	const normalized = repoPath.replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
	if (!normalized) {
		throw new GSyncError("云端仓库路径不能为空。");
	}
	const segments = normalized
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	if (segments.length === 0) {
		throw new GSyncError("云端仓库路径格式无效。");
	}
	for (const seg of segments) {
		if (seg === "." || seg === "..") {
			throw new GSyncError(`云端仓库路径包含非法段 "${seg}"。`);
		}
	}
	return segments;
}

function concatUint8Arrays(parts: Uint8Array[]): ArrayBuffer {
	const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out.buffer;
}

function buildMultipartRelatedBody(
	metadata: Record<string, unknown>,
	content: ArrayBuffer,
	contentType = "text/markdown; charset=utf-8"
): { body: ArrayBuffer; boundary: string } {
	const boundary = `gsync_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	const encoder = new TextEncoder();
	const metaPart = encoder.encode(
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
			`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`
	);
	const fileBytes = new Uint8Array(content);
	const closing = encoder.encode(`\r\n--${boundary}--\r\n`);
	return {
		body: concatUint8Arrays([metaPart, fileBytes, closing]),
		boundary,
	};
}

function parseJsonResponse<T>(text: string, preParsed?: unknown): T {
	if (preParsed !== undefined && preParsed !== null && typeof preParsed === "object") {
		return preParsed as T;
	}
	return JSON.parse(text) as T;
}

interface DriveListResponse {
	nextPageToken?: string;
	files?: DriveFileMetadata[];
}

export class GoogleDriveClient implements DriveClientLike {
	private readonly http: AuthenticatedHttpClient;

	constructor(http: AuthenticatedHttpClient) {
		this.http = http;
	}

	async getCurrentUser(): Promise<{ emailAddress?: string; displayName?: string }> {
		const res = await this.http.request({
			url: `${GOOGLE_DRIVE_API_BASE}/about?fields=user(displayName,emailAddress)`,
			method: "GET",
		});
		const data = parseJsonResponse<{ user?: { emailAddress?: string; displayName?: string } }>(
			res.text,
			res.json
		);
		return {
			emailAddress: data.user?.emailAddress,
			displayName: data.user?.displayName,
		};
	}

	async verifyFolderExists(folderId: string): Promise<boolean> {
		try {
			const res = await this.http.request({
				url: `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?fields=id,trashed,mimeType&supportsAllDrives=true`,
				method: "GET",
			});
			const data = parseJsonResponse<{ id?: string; trashed?: boolean; mimeType?: string }>(
				res.text,
				res.json
			);
			return Boolean(data.id && !data.trashed && data.mimeType === GOOGLE_FOLDER_MIME);
		} catch (err) {
			if (err instanceof HttpError && err.status === 404) {
				return false;
			}
			throw err;
		}
	}

	async resolveOrCreateRepoFolder(
		repoPath: string
	): Promise<{ folderId: string; created: boolean; warnings: SyncLogDetail[] }> {
		const segments = splitRepoPath(repoPath);
		const warnings: SyncLogDetail[] = [];
		let parentId = "root";
		let createdAny = false;
		const walked: string[] = [];

		for (const segment of segments) {
			walked.push(segment);
			const currentPath = walked.join("/");
			const matches = await this.findChildFolders(parentId, segment);

			if (matches.length === 0) {
				const created = await this.createFolder(parentId, segment);
				parentId = created.id;
				createdAny = true;
			} else {
				// Sorted by modifiedTime desc in query; index 0 is most recently modified
				const chosen = matches[0];
				if (matches.length > 1) {
					warnings.push({
						path: currentPath,
						action: "resolve_folder",
						level: "warn",
						message: `云端目录 "${currentPath}" 存在 ${matches.length} 个同名文件夹，已自动绑定最近修改的文件夹（ID: ${chosen.id}）。`,
					});
				}
				parentId = chosen.id;
			}
		}

		return { folderId: parentId, created: createdAny, warnings };
	}

	async listAllMarkdownFiles(
		rootFolderId: string,
		shouldIgnorePath: (relativePath: string, isDir?: boolean) => boolean,
		baselineFiles?: Record<string, BaselineEntry>,
		scope?: ScanScopeOptions
	): Promise<RemoteScanResult> {
		const syncObsidianConfig = Boolean(scope?.syncObsidianConfig);
		const configDir = scope?.configDir ?? DEFAULT_CONFIG_DIR;
		const files = new Map<string, RemoteFileSnapshot>();
		const folderIdCache = new Map<string, string>();
		const warnings: SyncLogDetail[] = [];

		// Track folder modifiedTime to resolve duplicate remote subfolders deterministically
		const folderModifiedMap = new Map<string, string>();
		const queue: Array<{ folderId: string; prefix: string }> = [{ folderId: rootFolderId, prefix: "" }];

		while (queue.length > 0) {
			const current = queue.shift()!;
			const children = await this.listFolderChildren(current.folderId);

			for (const item of children) {
				const relPath = current.prefix ? `${current.prefix}/${item.name}` : item.name;

				if (item.mimeType === GOOGLE_FOLDER_MIME) {
					if (shouldIgnorePath(relPath, true)) {
						continue;
					}
					const existingFolderId = folderIdCache.get(relPath);
					if (existingFolderId) {
						const prevMod = folderModifiedMap.get(relPath) ?? "";
						if ((item.modifiedTime ?? "") > prevMod) {
							folderIdCache.set(relPath, item.id);
							folderModifiedMap.set(relPath, item.modifiedTime ?? "");
						}
						warnings.push({
							path: relPath,
							action: "scan_remote",
							level: "warn",
							message: `云端子目录 "${relPath}" 存在同名重复文件夹，已合并扫描并优先绑定最近修改目录。`,
						});
					} else {
						folderIdCache.set(relPath, item.id);
						folderModifiedMap.set(relPath, item.modifiedTime ?? "");
					}
					queue.push({ folderId: item.id, prefix: relPath });
					continue;
				}

				if (!isSyncableFilePath(relPath, syncObsidianConfig, configDir)) {
					continue;
				}
				if (shouldIgnorePath(relPath, false)) {
					continue;
				}

				const size = Number(item.size ?? 0);
				const md5 = item.md5Checksum ?? (size === 0 ? EMPTY_FILE_MD5 : "");
				const candidate: RemoteFileSnapshot = {
					fileId: item.id,
					relativePath: relPath,
					md5,
					modifiedTime: item.modifiedTime,
					size: Number.isFinite(size) ? size : 0,
					parentId: current.folderId,
				};

				const existing = files.get(relPath);
				if (!existing) {
					files.set(relPath, candidate);
					continue;
				}

				// Duplicate .md files with same relative path on Google Drive:
				// Prefer the fileId already tracked in Baseline; otherwise choose most recently modified.
				const baselineFileId = baselineFiles?.[relPath]?.fileId;
				let chosen = existing;
				if (baselineFileId) {
					if (candidate.fileId === baselineFileId) {
						chosen = candidate;
					} else if (existing.fileId !== baselineFileId && candidate.modifiedTime > existing.modifiedTime) {
						chosen = candidate;
					}
				} else if (candidate.modifiedTime > existing.modifiedTime) {
					chosen = candidate;
				}

				files.set(relPath, chosen);
				warnings.push({
					path: relPath,
					action: "scan_remote",
					level: "warn",
					message: `云端同目录存在同名重复文件 "${relPath}"，已优先选用 fileId=${chosen.fileId}。`,
				});
			}
		}

		return { files, folderIdCache, warnings };
	}

	async ensureFolderPath(
		rootFolderId: string,
		dirPath: string,
		cache: Map<string, string>
	): Promise<string> {
		const normalized = dirPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (!normalized) {
			return rootFolderId;
		}
		const cached = cache.get(normalized);
		if (cached) {
			return cached;
		}

		const segments = normalized.split("/").filter((s) => s.length > 0);
		let parentId = rootFolderId;
		let acc = "";

		for (const seg of segments) {
			acc = acc ? `${acc}/${seg}` : seg;
			const hit = cache.get(acc);
			if (hit) {
				parentId = hit;
				continue;
			}
			const existing = await this.findChildFolders(parentId, seg);
			if (existing.length > 0) {
				parentId = existing[0].id;
			} else {
				const created = await this.createFolder(parentId, seg);
				parentId = created.id;
			}
			cache.set(acc, parentId);
		}

		return parentId;
	}

	async uploadNewFile(
		parentId: string,
		name: string,
		content: ArrayBuffer
	): Promise<DriveFileMetadata> {
		const metadata = { name, parents: [parentId] };
		const contentType = guessContentType(name);

		if (content.byteLength <= MULTIPART_UPLOAD_THRESHOLD_BYTES) {
			const { body, boundary } = buildMultipartRelatedBody(metadata, content, contentType);
			const res = await this.http.request({
				url: `${GOOGLE_DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
				method: "POST",
				headers: {
					"Content-Type": `multipart/related; boundary=${boundary}`,
				},
				body,
			});
			return parseJsonResponse<DriveFileMetadata>(res.text, res.json);
		}

		return this.resumableUpload({
			method: "POST",
			initUrl: `${GOOGLE_DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
			metadata,
			content,
			contentType,
		});
	}

	async updateFileContent(
		fileId: string,
		content: ArrayBuffer,
		fileName?: string
	): Promise<DriveFileMetadata> {
		const encodedId = encodeURIComponent(fileId);
		const contentType = guessContentType(fileName);

		if (content.byteLength <= MULTIPART_UPLOAD_THRESHOLD_BYTES) {
			const res = await this.http.request({
				url: `${GOOGLE_DRIVE_UPLOAD_BASE}/files/${encodedId}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
				method: "PATCH",
				headers: {
					"Content-Type": contentType,
				},
				body: content,
			});
			return parseJsonResponse<DriveFileMetadata>(res.text, res.json);
		}

		return this.resumableUpload({
			method: "PATCH",
			initUrl: `${GOOGLE_DRIVE_UPLOAD_BASE}/files/${encodedId}?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
			content,
			contentType,
		});
	}

	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const res = await this.http.request({
			url: `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
			method: "GET",
		});
		return res.arrayBuffer;
	}

	async trashFile(fileId: string): Promise<void> {
		await this.http.request({
			url: `${GOOGLE_DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
			method: "PATCH",
			headers: {
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({ trashed: true }),
		});
	}

	private async findChildFolders(parentId: string, name: string): Promise<DriveFileMetadata[]> {
		const escapedName = escapeDriveQueryValue(name);
		const escapedParent = escapeDriveQueryValue(parentId);
		const q = `name = '${escapedName}' and '${escapedParent}' in parents and mimeType = '${GOOGLE_FOLDER_MIME}' and trashed = false`;

		const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files`);
		url.searchParams.set("q", q);
		url.searchParams.set("orderBy", "modifiedTime desc");
		url.searchParams.set("pageSize", "100");
		url.searchParams.set("fields", `files(${FILE_FIELDS})`);
		url.searchParams.set("supportsAllDrives", "true");
		url.searchParams.set("includeItemsFromAllDrives", "true");

		const res = await this.http.request({ url: url.toString(), method: "GET" });
		const data = parseJsonResponse<DriveListResponse>(res.text, res.json);
		return data.files ?? [];
	}

	private async createFolder(parentId: string, name: string): Promise<DriveFileMetadata> {
		const res = await this.http.request({
			url: `${GOOGLE_DRIVE_API_BASE}/files?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`,
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=UTF-8",
			},
			body: JSON.stringify({
				name,
				mimeType: GOOGLE_FOLDER_MIME,
				parents: [parentId],
			}),
		});
		return parseJsonResponse<DriveFileMetadata>(res.text, res.json);
	}

	private async listFolderChildren(folderId: string): Promise<DriveFileMetadata[]> {
		const escapedParent = escapeDriveQueryValue(folderId);
		const q = `'${escapedParent}' in parents and trashed = false`;
		const all: DriveFileMetadata[] = [];
		let pageToken: string | undefined;

		do {
			const url = new URL(`${GOOGLE_DRIVE_API_BASE}/files`);
			url.searchParams.set("q", q);
			url.searchParams.set("pageSize", "1000");
			url.searchParams.set("fields", `nextPageToken,files(${FILE_FIELDS})`);
			url.searchParams.set("supportsAllDrives", "true");
			url.searchParams.set("includeItemsFromAllDrives", "true");
			if (pageToken) {
				url.searchParams.set("pageToken", pageToken);
			}

			const res = await this.http.request({ url: url.toString(), method: "GET" });
			const data = parseJsonResponse<DriveListResponse>(res.text, res.json);
			if (data.files) {
				all.push(...data.files);
			}
			pageToken = data.nextPageToken;
		} while (pageToken);

		return all;
	}

	private async resumableUpload(params: {
		method: "POST" | "PATCH";
		initUrl: string;
		metadata?: Record<string, unknown>;
		content: ArrayBuffer;
		contentType: string;
	}): Promise<DriveFileMetadata> {
		const totalSize = params.content.byteLength;
		const initHeaders: Record<string, string> = {
			"X-Upload-Content-Type": params.contentType,
			"X-Upload-Content-Length": String(totalSize),
		};
		let initBody: string | undefined;
		if (params.metadata) {
			initHeaders["Content-Type"] = "application/json; charset=UTF-8";
			initBody = JSON.stringify(params.metadata);
		}

		const initRes = await this.http.request({
			url: params.initUrl,
			method: params.method,
			headers: initHeaders,
			body: initBody,
		});

		const sessionUri = initRes.headers["location"];
		if (!sessionUri) {
			throw new GSyncError("Google Drive Resumable Upload 未返回上传会话地址（Location）。");
		}

		const bytes = new Uint8Array(params.content);
		let offset = 0;

		while (offset < totalSize) {
			const end = Math.min(offset + RESUMABLE_CHUNK_SIZE_BYTES, totalSize);
			const chunk = bytes.slice(offset, end).buffer;
			const contentRange = `bytes ${offset}-${end - 1}/${totalSize}`;

			const chunkRes = await this.http.request({
				url: sessionUri,
				method: "PUT",
				headers: {
					"Content-Type": params.contentType,
					"Content-Range": contentRange,
				},
				body: chunk,
			});

			if (chunkRes.status === 200 || chunkRes.status === 201) {
				return parseJsonResponse<DriveFileMetadata>(chunkRes.text, chunkRes.json);
			}
			if (chunkRes.status === 308) {
				offset = end;
				continue;
			}
			throw new HttpError(
				chunkRes.status,
				`分块上传异常（HTTP ${chunkRes.status}）`,
				chunkRes.text
			);
		}

		throw new GSyncError("Resumable Upload 未收到最终文件元数据响应。");
	}
}
