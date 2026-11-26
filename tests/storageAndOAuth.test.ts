import { describe, expect, it } from "vitest";
import { buildGoogleAuthUrl, generatePkcePair } from "../src/auth/GoogleAuthService";
import { parseOAuthCallbackUrl } from "../src/auth/OAuthLoopbackServer";
import { GOOGLE_OAUTH_SCOPE, MAX_LOG_ENTRIES } from "../src/constants";
import { StorageService, type FileAdapterLike } from "../src/storage/StorageService";

describe("OAuth callback parser & PKCE URL builder", () => {
	it("builds Google OAuth URL with drive scope, offline access, consent prompt, state, and S256 PKCE", () => {
		const { codeVerifier, codeChallenge } = generatePkcePair();
		expect(codeVerifier.length).toBeGreaterThanOrEqual(40);
		expect(codeChallenge).not.toContain("+");
		expect(codeChallenge).not.toContain("/");
		expect(codeChallenge).not.toContain("=");

		const url = new URL(
			buildGoogleAuthUrl({
				clientId: "test-client-id",
				redirectUri: "http://127.0.0.1:43210/callback",
				state: "state-abc",
				codeChallenge,
			})
		);
		expect(url.searchParams.get("scope")).toBe(GOOGLE_OAUTH_SCOPE);
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.get("state")).toBe("state-abc");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("validates callback path, state CSRF check, error params, and authorization code", () => {
		expect(parseOAuthCallbackUrl("/favicon.ico", "s1")).toEqual({ kind: "not_found" });

		expect(parseOAuthCallbackUrl("/callback?state=s1&code=code-123", "s1")).toEqual({
			kind: "ok",
			code: "code-123",
		});

		const mismatch = parseOAuthCallbackUrl("/callback?state=wrong&code=code-123", "s1");
		expect(mismatch.kind).toBe("error");
		if (mismatch.kind === "error") {
			expect(mismatch.errorMessage).toContain("state");
		}

		const denied = parseOAuthCallbackUrl("/callback?error=access_denied&state=s1", "s1");
		expect(denied.kind).toBe("error");
		if (denied.kind === "error") {
			expect(denied.errorMessage).toContain("access_denied");
		}

		const noCode = parseOAuthCallbackUrl("/callback?state=s1", "s1");
		expect(noCode.kind).toBe("error");
	});
});

describe("StorageService — split JSON persistence & 200-entry log cap", () => {
	it("stores settings in data.json, baseline in baseline.json, and caps logs.json at 200 entries", async () => {
		let savedData: unknown = null;
		const fsMap = new Map<string, string>();

		const adapter: FileAdapterLike = {
			exists: async (p) => fsMap.has(p),
			read: async (p) => {
				const v = fsMap.get(p);
				if (v === undefined) throw new Error("ENOENT");
				return v;
			},
			write: async (p, data) => {
				fsMap.set(p, data);
			},
			remove: async (p) => {
				fsMap.delete(p);
			},
			mkdir: async () => {},
		};

		const storage = new StorageService(
			{
				loadData: async () => savedData,
				saveData: async (d) => {
					savedData = d;
				},
			},
			adapter,
			".obsidian/plugins/obsidian-g-sync"
		);

		const settings = await storage.loadSettings();
		settings.clientId = "cid-1";
		await storage.saveSettings(settings);
		expect((savedData as { clientId: string }).clientId).toBe("cid-1");

		await storage.saveBaseline({
			version: 1,
			folderId: "fid-root",
			updatedAt: "2026-11-24T12:00:00Z",
			files: {},
		});
		expect(fsMap.has(".obsidian/plugins/obsidian-g-sync/baseline.json")).toBe(true);
		expect((await storage.loadBaseline())?.folderId).toBe("fid-root");

		await storage.resetBaseline();
		expect(await storage.loadBaseline()).toBeNull();

		for (let i = 0; i < MAX_LOG_ENTRIES + 15; i++) {
			await storage.appendLog({
				id: `log-${i}`,
				timestamp: new Date(1000 + i * 1000).toISOString(),
				trigger: "manual",
				level: "success",
				summaryText: `entry ${i}`,
				details: [],
			});
		}

		const loadedLogs = await storage.loadLogs();
		expect(loadedLogs).toHaveLength(MAX_LOG_ENTRIES);
		expect(loadedLogs[0].id).toBe(`log-${MAX_LOG_ENTRIES + 14}`);
		expect(fsMap.has(".obsidian/plugins/obsidian-g-sync/logs.json")).toBe(true);
	});
});
