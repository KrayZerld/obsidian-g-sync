import crypto from "crypto";
import {
	GOOGLE_DRIVE_API_BASE,
	GOOGLE_OAUTH_AUTH_URL,
	GOOGLE_OAUTH_SCOPE,
	GOOGLE_OAUTH_TOKEN_URL,
	OAUTH_TIMEOUT_MS,
	TOKEN_REFRESH_BUFFER_MS,
} from "../constants";
import {
	AuthExpiredError,
	GSyncError,
	HttpError,
	type AuthState,
	type GSyncSettings,
	type RawHttpRequester,
	type TokenProvider,
} from "../types";
import { startOAuthLoopbackServer, type OAuthLoopbackHandle } from "./OAuthLoopbackServer";

export function base64UrlEncode(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
	const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
	const digest = crypto.createHash("sha256").update(codeVerifier).digest();
	const codeChallenge = base64UrlEncode(digest);
	return { codeVerifier, codeChallenge };
}

export function generateOAuthState(): string {
	return base64UrlEncode(crypto.randomBytes(24));
}

export function buildGoogleAuthUrl(params: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): string {
	const url = new URL(GOOGLE_OAUTH_AUTH_URL);
	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", GOOGLE_OAUTH_SCOPE);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

interface TokenResponseBody {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

export interface GoogleAuthServiceDeps {
	getSettings: () => GSyncSettings;
	saveSettings: () => Promise<void>;
	rawRequest: RawHttpRequester;
	openExternalUrl?: (url: string) => void;
	now?: () => number;
	loopbackTimeoutMs?: number;
}

export class GoogleAuthService implements TokenProvider {
	private readonly deps: GoogleAuthServiceDeps;
	private activeLoopback: OAuthLoopbackHandle | null = null;
	private inflightRefresh: Promise<string> | null = null;

	constructor(deps: GoogleAuthServiceDeps) {
		this.deps = deps;
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	async authorize(): Promise<AuthState> {
		const settings = this.deps.getSettings();
		const clientId = settings.clientId.trim();
		const clientSecret = settings.clientSecret.trim();

		if (!clientId || !clientSecret) {
			throw new GSyncError("请先填写 Google OAuth Client ID 和 Client Secret。");
		}

		// Close any previous pending auth server
		this.abortPendingAuth();

		const state = generateOAuthState();
		const { codeVerifier, codeChallenge } = generatePkcePair();

		const server = await startOAuthLoopbackServer(
			state,
			this.deps.loopbackTimeoutMs ?? OAUTH_TIMEOUT_MS
		);
		this.activeLoopback = server;

		try {
			const authUrl = buildGoogleAuthUrl({
				clientId,
				redirectUri: server.redirectUri,
				state,
				codeChallenge,
			});

			if (this.deps.openExternalUrl) {
				this.deps.openExternalUrl(authUrl);
			} else if (typeof window !== "undefined") {
				window.open(authUrl, "_blank");
			}

			const { code } = await server.waitForCallback();
			const tokenData = await this.exchangeAuthorizationCode({
				code,
				clientId,
				clientSecret,
				redirectUri: server.redirectUri,
				codeVerifier,
			});

			const existingRefreshToken = settings.auth.tokens?.refreshToken;
			const refreshToken = tokenData.refresh_token || existingRefreshToken;
			if (!tokenData.access_token || !refreshToken) {
				throw new GSyncError(
					"Google 未返回 refresh_token，请确认 OAuth 客户端类型为桌面应用并在同意页重新授权。"
				);
			}

			const expiresInSec = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 3600;
			const expiresAt = this.now() + expiresInSec * 1000;

			// Fetch account identity via Drive about endpoint (works with drive scope directly)
			const userInfo = await this.fetchAccountIdentity(tokenData.access_token);

			settings.auth = {
				...settings.auth,
				status: "authenticated",
				accountEmail: userInfo.emailAddress,
				accountName: userInfo.displayName,
				tokens: {
					accessToken: tokenData.access_token,
					refreshToken,
					expiresAt,
				},
			};

			await this.deps.saveSettings();
			return settings.auth;
		} finally {
			if (this.activeLoopback === server) {
				this.activeLoopback = null;
			}
			server.close();
		}
	}

	async getValidAccessToken(forceRefresh = false): Promise<string> {
		const settings = this.deps.getSettings();
		const auth = settings.auth;

		if (auth.status === "expired") {
			throw new AuthExpiredError();
		}
		if (auth.status !== "authenticated" || !auth.tokens?.refreshToken) {
			throw new AuthExpiredError("尚未完成 Google 账号授权，请前往 Auth 标签页登录。");
		}

		const remainingMs = auth.tokens.expiresAt - this.now();
		if (!forceRefresh && auth.tokens.accessToken && remainingMs > TOKEN_REFRESH_BUFFER_MS) {
			return auth.tokens.accessToken;
		}

		if (this.inflightRefresh) {
			return this.inflightRefresh;
		}

		this.inflightRefresh = this.performTokenRefresh().finally(() => {
			this.inflightRefresh = null;
		});
		return this.inflightRefresh;
	}

	async disconnect(): Promise<void> {
		this.abortPendingAuth();
		const settings = this.deps.getSettings();
		settings.auth = {
			status: "unauthenticated",
		};
		await this.deps.saveSettings();
	}

	abortPendingAuth(): void {
		if (this.activeLoopback) {
			const current = this.activeLoopback;
			this.activeLoopback = null;
			current.close();
		}
	}

	private async performTokenRefresh(): Promise<string> {
		const settings = this.deps.getSettings();
		const tokens = settings.auth.tokens;
		const clientId = settings.clientId.trim();
		const clientSecret = settings.clientSecret.trim();

		if (!tokens?.refreshToken) {
			await this.markExpired();
			throw new AuthExpiredError();
		}
		if (!clientId || !clientSecret) {
			throw new GSyncError("缺少 Google OAuth Client ID 或 Client Secret，无法刷新 Token。");
		}

		const form = new URLSearchParams({
			client_id: clientId,
			client_secret: clientSecret,
			refresh_token: tokens.refreshToken,
			grant_type: "refresh_token",
		});

		const response = await this.deps.rawRequest({
			url: GOOGLE_OAUTH_TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
			throw: false,
		});

		const body = this.parseJsonSafe<TokenResponseBody>(response.text, response.json);

		if (response.status >= 400) {
			const errCode = body?.error ?? "";
			const errDesc = body?.error_description ?? response.text;
			if (errCode === "invalid_grant" || errCode === "unauthorized_client") {
				await this.markExpired();
				throw new AuthExpiredError(`Google 授权已失效（${errCode}），请前往 Auth 页重新授权。`);
			}
			throw new HttpError(
				response.status,
				`刷新 Access Token 失败（HTTP ${response.status}）：${errDesc || errCode}`,
				response.text
			);
		}

		if (!body?.access_token) {
			throw new GSyncError("Google Token 刷新接口未返回有效的 access_token。");
		}

		const expiresInSec = typeof body.expires_in === "number" ? body.expires_in : 3600;
		settings.auth = {
			...settings.auth,
			status: "authenticated",
			tokens: {
				accessToken: body.access_token,
				refreshToken: body.refresh_token || tokens.refreshToken,
				expiresAt: this.now() + expiresInSec * 1000,
			},
		};
		await this.deps.saveSettings();
		return body.access_token;
	}

	private async markExpired(): Promise<void> {
		const settings = this.deps.getSettings();
		settings.auth = {
			...settings.auth,
			status: "expired",
		};
		await this.deps.saveSettings();
	}

	private async exchangeAuthorizationCode(params: {
		code: string;
		clientId: string;
		clientSecret: string;
		redirectUri: string;
		codeVerifier: string;
	}): Promise<TokenResponseBody> {
		const form = new URLSearchParams({
			code: params.code,
			client_id: params.clientId,
			client_secret: params.clientSecret,
			redirect_uri: params.redirectUri,
			grant_type: "authorization_code",
			code_verifier: params.codeVerifier,
		});

		const response = await this.deps.rawRequest({
			url: GOOGLE_OAUTH_TOKEN_URL,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: form.toString(),
			throw: false,
		});

		const body = this.parseJsonSafe<TokenResponseBody>(response.text, response.json);
		if (response.status >= 400) {
			const msg = body?.error_description || body?.error || response.text || `HTTP ${response.status}`;
			throw new HttpError(response.status, `换取 OAuth Token 失败：${msg}`, response.text);
		}
		return body ?? {};
	}

	private async fetchAccountIdentity(
		accessToken: string
	): Promise<{ emailAddress?: string; displayName?: string }> {
		try {
			const response = await this.deps.rawRequest({
				url: `${GOOGLE_DRIVE_API_BASE}/about?fields=user(displayName,emailAddress)`,
				method: "GET",
				headers: { Authorization: `Bearer ${accessToken}` },
				throw: false,
			});
			if (response.status >= 200 && response.status < 300) {
				const parsed = this.parseJsonSafe<{ user?: { emailAddress?: string; displayName?: string } }>(
					response.text,
					response.json
				);
				return {
					emailAddress: parsed?.user?.emailAddress,
					displayName: parsed?.user?.displayName,
				};
			}
		} catch {
			// Non-fatal: account email is informational
		}
		return {};
	}

	private parseJsonSafe<T>(text: string, preParsed?: unknown): T | null {
		if (preParsed && typeof preParsed === "object") {
			return preParsed as T;
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			return null;
		}
	}
}
