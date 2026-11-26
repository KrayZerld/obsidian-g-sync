import { requestUrl } from "obsidian";
import { MAX_HTTP_RETRIES, RETRY_BASE_DELAY_MS } from "../constants";
import {
	AuthExpiredError,
	HttpError,
	type HttpRequestOptions,
	type HttpResponseData,
	type RawHttpRequester,
	type TokenProvider,
} from "../types";

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	if (!headers) return result;
	for (const [key, value] of Object.entries(headers)) {
		result[key.toLowerCase()] = value;
	}
	return result;
}

export function createObsidianRawRequester(): RawHttpRequester {
	return async (options: HttpRequestOptions): Promise<HttpResponseData> => {
		const response = await requestUrl({
			url: options.url,
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			contentType: options.contentType,
			throw: false,
		});

		let parsedJson: unknown = undefined;
		try {
			parsedJson = response.json;
		} catch {
			// Non-JSON responses (e.g. binary download or empty body)
		}

		return {
			status: response.status,
			headers: normalizeHeaders(response.headers),
			text: response.text ?? "",
			arrayBuffer: response.arrayBuffer ?? new ArrayBuffer(0),
			json: parsedJson,
		};
	};
}

export function parseRetryAfterMs(headerValue: string | undefined): number | undefined {
	if (!headerValue) return undefined;
	const trimmed = headerValue.trim();
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1000, 60_000);
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
		const diff = dateMs - Date.now();
		return diff > 0 ? Math.min(diff, 60_000) : 0;
	}
	return undefined;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AuthenticatedHttpClientOptions {
	rawRequest: RawHttpRequester;
	tokenProvider: TokenProvider;
	maxRetries?: number;
	baseDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

export class AuthenticatedHttpClient {
	private readonly rawRequest: RawHttpRequester;
	private readonly tokenProvider: TokenProvider;
	private readonly maxRetries: number;
	private readonly baseDelayMs: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(options: AuthenticatedHttpClientOptions) {
		this.rawRequest = options.rawRequest;
		this.tokenProvider = options.tokenProvider;
		this.maxRetries = options.maxRetries ?? MAX_HTTP_RETRIES;
		this.baseDelayMs = options.baseDelayMs ?? RETRY_BASE_DELAY_MS;
		this.sleep = options.sleep ?? defaultSleep;
	}

	async request(options: HttpRequestOptions): Promise<HttpResponseData> {
		let refreshedAfter401 = false;
		let forceRefreshNext = false;
		let retryAttempt = 0;

		while (true) {
			const accessToken = await this.tokenProvider.getValidAccessToken(forceRefreshNext);
			forceRefreshNext = false;
			const headers: Record<string, string> = {
				...(options.headers ?? {}),
				Authorization: `Bearer ${accessToken}`,
			};

			let response: HttpResponseData;
			try {
				response = await this.rawRequest({
					...options,
					headers,
					throw: false,
				});
			} catch (err) {
				if (err instanceof AuthExpiredError) {
					throw err;
				}
				if (retryAttempt < this.maxRetries) {
					const delay = this.baseDelayMs * Math.pow(2, retryAttempt);
					retryAttempt++;
					await this.sleep(delay);
					continue;
				}
				const message = err instanceof Error ? err.message : String(err);
				throw new HttpError(0, `网络请求失败：${message}`);
			}

			// 401 Unauthorized: attempt one forced token refresh and replay
			if (response.status === 401 && !refreshedAfter401) {
				refreshedAfter401 = true;
				forceRefreshNext = true;
				continue;
			}

			// 429 Too Many Requests or 5xx Server Error: exponential backoff retry
			if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
				const retryAfterMs = parseRetryAfterMs(response.headers["retry-after"]);
				if (retryAttempt < this.maxRetries) {
					const delay = retryAfterMs ?? this.baseDelayMs * Math.pow(2, retryAttempt);
					retryAttempt++;
					await this.sleep(delay);
					continue;
				}
				throw new HttpError(
					response.status,
					`Google Drive 服务响应异常（HTTP ${response.status}），重试 ${this.maxRetries} 次后仍失败。`,
					response.text,
					retryAfterMs
				);
			}

			// 308 is expected for Resumable Upload chunk acknowledgements
			if (response.status === 308 || (response.status >= 200 && response.status < 300)) {
				return response;
			}

			throw new HttpError(
				response.status,
				`Google Drive API 请求失败（HTTP ${response.status}）：${this.extractErrorMessage(response)}`,
				response.text
			);
		}
	}

	private extractErrorMessage(response: HttpResponseData): string {
		try {
			const data = (response.json ?? JSON.parse(response.text)) as {
				error?: { message?: string } | string;
			};
			if (typeof data?.error === "string") return data.error;
			if (typeof data?.error?.message === "string") return data.error.message;
		} catch {
			// Ignore JSON parse errors
		}
		return response.text.slice(0, 200) || `HTTP ${response.status}`;
	}
}
