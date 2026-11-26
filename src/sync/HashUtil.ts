import crypto from "crypto";
import { sanitizeDeviceName } from "../constants";

export function computeMd5(input: ArrayBuffer | Uint8Array | Buffer | string): string {
	const hash = crypto.createHash("md5");
	if (typeof input === "string") {
		hash.update(input, "utf8");
	} else if (Buffer.isBuffer(input)) {
		hash.update(input);
	} else if (input instanceof Uint8Array) {
		hash.update(input);
	} else {
		hash.update(new Uint8Array(input));
	}
	return hash.digest("hex");
}

export function normalizeRelativePath(input: string): string {
	return input
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "")
		.replace(/\/+/g, "/")
		.replace(/^\/+|\/+$/g, "");
}

export function splitDirAndName(relativePath: string): { dir: string; name: string } {
	const normalized = normalizeRelativePath(relativePath);
	const idx = normalized.lastIndexOf("/");
	if (idx < 0) {
		return { dir: "", name: normalized };
	}
	return {
		dir: normalized.slice(0, idx),
		name: normalized.slice(idx + 1),
	};
}

/**
 * Shortens a nested path to ".../<parent>/<filename>" when depth >= 3.
 * Paths with depth <= 2 (e.g. "note.md" or "02/note.md") are kept intact.
 */
export function shortenDisplayPath(relativePath: string): string {
	const normalized = normalizeRelativePath(relativePath);
	if (!normalized) return "";
	const parts = normalized.split("/");
	if (parts.length <= 2) {
		return normalized;
	}
	return `.../${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

export function formatConflictTimestamp(date: Date = new Date()): string {
	const yyyy = date.getFullYear();
	const mm = pad2(date.getMonth() + 1);
	const dd = pad2(date.getDate());
	const hh = pad2(date.getHours());
	const mi = pad2(date.getMinutes());
	const ss = pad2(date.getSeconds());
	return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

export function buildConflictPath(
	relativePath: string,
	deviceName: string,
	date: Date = new Date(),
	existingPaths?: ReadonlySet<string>
): string {
	const { dir, name } = splitDirAndName(relativePath);
	const dotIdx = name.lastIndexOf(".");
	const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
	const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
	const safeDevice = sanitizeDeviceName(deviceName) || "device";
	const stamp = formatConflictTimestamp(date);

	const lowerExisting = new Set<string>();
	if (existingPaths) {
		for (const p of existingPaths) {
			lowerExisting.add(normalizeRelativePath(p).toLowerCase());
		}
	}

	const makeCandidate = (suffix: string): string => {
		const fileName = `${stem}.conflict-${safeDevice}-${stamp}${suffix}${ext}`;
		return dir ? `${dir}/${fileName}` : fileName;
	};

	let candidate = makeCandidate("");
	if (!lowerExisting.has(candidate.toLowerCase())) {
		return candidate;
	}

	let counter = 1;
	while (counter < 1000) {
		candidate = makeCandidate(`-${counter}`);
		if (!lowerExisting.has(candidate.toLowerCase())) {
			return candidate;
		}
		counter++;
	}
	return makeCandidate(`-${Date.now()}`);
}
