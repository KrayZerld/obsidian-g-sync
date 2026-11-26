import { describe, expect, it, vi } from "vitest";
import { GoogleAuthService } from "../src/auth/GoogleAuthService";
import { MULTIPART_UPLOAD_THRESHOLD_BYTES, createDefaultSettings } from "../src/constants";
import { GoogleDriveClient, escapeDriveQueryValue } from "../src/drive/GoogleDriveClient";
import { AuthenticatedHttpClient } from "../src/drive/HttpClient";
import {
	AuthExpiredError,
	HttpError,
	type GSyncSettings,
	type HttpRequestOptions,
	type HttpResponseData,
	type RawHttpRequester,
} from "../src/types";

function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponseData {
	const text = JSON.stringify(body);
	return {
		status,
		headers,
		text,
		arrayBuffer: new ArrayBuffer(0),
		json: body,
	};
}

describe("GoogleAuthService — proactive token refresh & invalid_grant handling", () => {
	it("reuses token when > 2 min remain and refreshes automatically when < 2 min remain", async () => {
		let nowMs = 1_000_000;
		const settings: GSyncSettings = {
			...createDefaultSettings(),
			clientId: "cid",
			clientSecret: "csec",
			auth: {
				status: "authenticated",
				tokens: {
					accessToken: "initial-access",
					refreshToken: "valid-refresh",
					expiresAt: nowMs + 5 * 60 * 1000, // 5 min remaining
				},
			},
		};

		const rawRequest = vi.fn<RawHttpRequester>(async () =>
			jsonResp(200, { access_token: "refreshed-access", expires_in: 3600 })
		);
		const saveSettings = vi.fn(async () => {});

		const auth = new GoogleAuthService({
			getSettings: () => settings,
			saveSettings,
			rawRequest,
			now: () => nowMs,
		});

		// > 2 min remaining: no refresh request
		expect(await auth.getValidAccessToken(false)).toBe("initial-access");
		expect(rawRequest).not.toHaveBeenCalled();

		// Advance to 90s remaining (< 2 min buffer): triggers proactive refresh
		nowMs += 3.5 * 60 * 1000;
		expect(await auth.getValidAccessToken(false)).toBe("refreshed-access");
		expect(rawRequest).toHaveBeenCalledTimes(1);
		expect(saveSettings).toHaveBeenCalledTimes(1);
		expect(settings.auth.tokens?.accessToken).toBe("refreshed-access");
	});

	it("marks auth expired and throws AuthExpiredError on invalid_grant", async () => {
		const settings: GSyncSettings = {
			...createDefaultSettings(),
			clientId: "cid",
			clientSecret: "csec",
			auth: {
				status: "authenticated",
				tokens: {
					accessToken: "old",
					refreshToken: "revoked-refresh",
					expiresAt: Date.now() - 1000,
				},
			},
		};

		const rawRequest = vi.fn<RawHttpRequester>(async () =>
			jsonResp(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })
		);

		const auth = new GoogleAuthService({
			getSettings: () => settings,
			saveSettings: async () => {},
			rawRequest,
		});

		await expect(auth.getValidAccessToken(false)).rejects.toThrow(AuthExpiredError);
		expect(settings.auth.status).toBe("expired");
	});
});

describe("AuthenticatedHttpClient — 429/5xx exponential backoff & 401 replay", () => {
	it("retries 429 and 503 with 1s / 2s / 4s exponential backoff and succeeds on final attempt", async () => {
		const delays: number[] = [];
		const responses = [
			jsonResp(429, { error: { message: "Rate limit" } }),
			jsonResp(503, { error: { message: "Backend unavailable" } }),
			jsonResp(500, { error: { message: "Internal error" } }),
			jsonResp(200, { ok: true }),
		];
		let idx = 0;

		const rawRequest = vi.fn<RawHttpRequester>(async () => responses[idx++]);
		const client = new AuthenticatedHttpClient({
			rawRequest,
			tokenProvider: { getValidAccessToken: async () => "tok" },
			maxRetries: 3,
			baseDelayMs: 1000,
			sleep: async (ms) => {
				delays.push(ms);
			},
		});

		const res = await client.request({ url: "https://example.test/files", method: "GET" });
		expect(res.status).toBe(200);
		expect(delays).toEqual([1000, 2000, 4000]);
		expect(rawRequest).toHaveBeenCalledTimes(4);
	});

	it("throws HttpError after exhausting max retries on persistent 429", async () => {
		const delays: number[] = [];
		const rawRequest = vi.fn<RawHttpRequester>(async () =>
			jsonResp(429, { error: { message: "Rate limit" } })
		);
		const client = new AuthenticatedHttpClient({
			rawRequest,
			tokenProvider: { getValidAccessToken: async () => "tok" },
			maxRetries: 3,
			baseDelayMs: 1000,
			sleep: async (ms) => {
				delays.push(ms);
			},
		});

		await expect(
			client.request({ url: "https://example.test/files", method: "GET" })
		).rejects.toThrow(HttpError);
		expect(delays).toEqual([1000, 2000, 4000]);
		expect(rawRequest).toHaveBeenCalledTimes(4);
	});

	it("refreshes access token once on 401 Unauthorized and replays the original request", async () => {
		let tokenCalls = 0;
		const tokenProvider = {
			getValidAccessToken: vi.fn(async (force?: boolean) => {
				tokenCalls++;
				return force ? "fresh-token" : "stale-token";
			}),
		};

		const seenAuthHeaders: string[] = [];
		const rawRequest = vi.fn<RawHttpRequester>(async (opts: HttpRequestOptions) => {
			seenAuthHeaders.push(opts.headers?.Authorization ?? "");
			if (seenAuthHeaders.length === 1) {
				return jsonResp(401, { error: { message: "Invalid Credentials" } });
			}
			return jsonResp(200, { ok: true });
		});

		const client = new AuthenticatedHttpClient({ rawRequest, tokenProvider });
		const res = await client.request({ url: "https://example.test/files", method: "GET" });

		expect(res.status).toBe(200);
		expect(tokenCalls).toBe(2); // initial get(false) -> forced refresh get(true) on replay
		expect(tokenProvider.getValidAccessToken).toHaveBeenNthCalledWith(1, false);
		expect(tokenProvider.getValidAccessToken).toHaveBeenNthCalledWith(2, true);
		expect(seenAuthHeaders).toEqual(["Bearer stale-token", "Bearer fresh-token"]);
		expect(rawRequest).toHaveBeenCalledTimes(2);
	});
});

describe("GoogleDriveClient — query escaping & Resumable Upload threshold", () => {
	it("escapes single quotes and backslashes in Google Drive query strings", () => {
		expect(escapeDriveQueryValue("Kray's \\ Vault")).toBe("Kray\\'s \\\\ Vault");
	});

	it("uses Resumable Upload automatically when file exceeds 5MB threshold", async () => {
		const calls: Array<{ method?: string; url: string }> = [];
		const rawRequest = vi.fn<RawHttpRequester>(async (opts) => {
			calls.push({ method: opts.method, url: opts.url });
			if (opts.url.includes("uploadType=resumable")) {
				return jsonResp(200, {}, { location: "https://upload.example.test/session-1" });
			}
			if (opts.url === "https://upload.example.test/session-1") {
				return jsonResp(200, {
					id: "large-id",
					name: "huge.md",
					md5Checksum: "abc",
					modifiedTime: "2026-11-24T12:00:00.000Z",
				});
			}
			return jsonResp(200, {});
		});

		const http = new AuthenticatedHttpClient({
			rawRequest,
			tokenProvider: { getValidAccessToken: async () => "tok" },
		});
		const drive = new GoogleDriveClient(http);

		const largeContent = new ArrayBuffer(MULTIPART_UPLOAD_THRESHOLD_BYTES + 1024);
		const meta = await drive.uploadNewFile("parent-1", "huge.md", largeContent);

		expect(meta.id).toBe("large-id");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toContain("uploadType=resumable");
		expect(calls[1].method).toBe("PUT");
		expect(calls[1].url).toBe("https://upload.example.test/session-1");
	});
});
