import http from "http";
import type { AddressInfo, Socket } from "net";
import { OAUTH_TIMEOUT_MS } from "../constants";

export interface OAuthCallbackResult {
	code: string;
}

export type ParsedOAuthCallback =
	| { kind: "not_found" }
	| { kind: "ok"; code: string }
	| { kind: "error"; title: string; htmlDetail: string; errorMessage: string };

export function parseOAuthCallbackUrl(rawUrl: string, expectedState: string): ParsedOAuthCallback {
	const url = new URL(rawUrl, "http://127.0.0.1");

	if (url.pathname !== "/callback") {
		return { kind: "not_found" };
	}

	const errorParam = url.searchParams.get("error");
	const errorDesc = url.searchParams.get("error_description");
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");

	if (errorParam) {
		const reason = errorDesc ? `${errorParam}: ${errorDesc}` : errorParam;
		return {
			kind: "error",
			title: "授权未完成",
			htmlDetail: `Google 返回错误：${reason}。可关闭此页面并返回 Obsidian。`,
			errorMessage: `Google 授权失败：${reason}`,
		};
	}

	if (!state || state !== expectedState) {
		return {
			kind: "error",
			title: "安全校验失败",
			htmlDetail: "OAuth state 参数不匹配，已拒绝本次授权回调。",
			errorMessage: "OAuth 回调 state 校验失败，可能存在 CSRF 风险或授权已过期。",
		};
	}

	if (!code) {
		return {
			kind: "error",
			title: "缺少授权码",
			htmlDetail: "回调参数中未包含 code，请返回 Obsidian 重试。",
			errorMessage: "Google 回调未返回授权码（code）。",
		};
	}

	return { kind: "ok", code };
}

export interface OAuthLoopbackHandle {
	port: number;
	redirectUri: string;
	waitForCallback: () => Promise<OAuthCallbackResult>;
	close: () => void;
}

function renderResultHtml(success: boolean, title: string, detail: string): string {
	const accent = success ? "#16a34a" : "#dc2626";
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>Obsidian g-Sync 授权结果</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111827; color: #f3f4f6; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1f2937; border: 1px solid #374151; border-radius: 12px; padding: 28px 32px; max-width: 440px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,0.35); }
  .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; background: ${accent}22; color: ${accent}; margin-bottom: 12px; }
  h1 { font-size: 20px; margin: 0 0 10px; }
  p { font-size: 14px; color: #d1d5db; line-height: 1.6; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="badge">Obsidian g-Sync</div>
    <h1>${title}</h1>
    <p>${detail}</p>
  </div>
</body>
</html>`;
}

export async function startOAuthLoopbackServer(
	expectedState: string,
	timeoutMs = OAUTH_TIMEOUT_MS
): Promise<OAuthLoopbackHandle> {
	return new Promise((resolveStart, rejectStart) => {
		const sockets = new Set<Socket>();
		let settled = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let resolveCallback!: (result: OAuthCallbackResult) => void;
		let rejectCallback!: (err: Error) => void;

		const callbackPromise = new Promise<OAuthCallbackResult>((res, rej) => {
			resolveCallback = res;
			rejectCallback = rej;
		});

		const cleanup = () => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
			for (const socket of sockets) {
				socket.destroy();
			}
			sockets.clear();
			try {
				server.close();
			} catch {
				// Ignore close errors
			}
		};

		const finishOk = (code: string) => {
			if (settled) return;
			settled = true;
			resolveCallback({ code });
			// Allow HTTP response flush before tearing down sockets
			setTimeout(cleanup, 150);
		};

		const finishErr = (error: Error) => {
			if (settled) return;
			settled = true;
			rejectCallback(error);
			setTimeout(cleanup, 150);
		};

		const server = http.createServer((req, res) => {
			const parsed = parseOAuthCallbackUrl(req.url ?? "/", expectedState);

			if (parsed.kind === "not_found") {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Not Found");
				return;
			}

			if (parsed.kind === "error") {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(renderResultHtml(false, parsed.title, parsed.htmlDetail));
				finishErr(new Error(parsed.errorMessage));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(renderResultHtml(true, "授权成功", "已成功接收 Google 授权，请关闭此标签页并返回 Obsidian。"));
			finishOk(parsed.code);
		});

		server.on("connection", (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
		});

		server.on("error", (err) => {
			if (!settled) {
				settled = true;
				rejectStart(err);
				rejectCallback(err);
			}
			cleanup();
		});

		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo | null;
			if (!addr || typeof addr.port !== "number") {
				const err = new Error("无法获取本地 OAuth 回环服务端口。");
				cleanup();
				rejectStart(err);
				return;
			}

			const redirectUri = `http://127.0.0.1:${addr.port}/callback`;

			timeoutHandle = setTimeout(() => {
				finishErr(new Error("Google 授权超时（超过 3 分钟未完成），已自动关闭本地回环监听。"));
			}, timeoutMs);

			resolveStart({
				port: addr.port,
				redirectUri,
				waitForCallback: () => callbackPromise,
				close: () => {
					if (!settled) {
						settled = true;
						rejectCallback(new Error("OAuth 授权流程已取消。"));
					}
					cleanup();
				},
			});
		});
	});
}
