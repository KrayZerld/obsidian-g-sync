import { DEFAULT_CONFIG_DIR, getBuiltinIgnoreRules } from "../constants";
import { normalizeRelativePath } from "./HashUtil";

export interface IgnoreMatcherOptions {
	syncObsidianConfig?: boolean;
	configDir?: string;
}

/**
 * Parses a multiline ignoreRules string into an ordered, deduplicated list of active rules
 * (skipping blank lines and # comments).
 */
export function parseUserIgnoreList(ignoreRulesText: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const rawLine of (ignoreRulesText ?? "").split("\n")) {
		const trimmed = rawLine.replace(/\r$/, "").trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result;
}

export function serializeUserIgnoreList(rules: readonly string[]): string {
	const seen = new Set<string>();
	const cleaned: string[] = [];
	for (const rule of rules) {
		const trimmed = rule.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			cleaned.push(trimmed);
		}
	}
	return cleaned.join("\n");
}

/**
 * Normalizes a user-entered ignore path or glob rule.
 * When `isFolder` is true, appends `/**` so the entire folder subtree is ignored.
 */
export function normalizeIgnoreRuleInput(raw: string, isFolder = false): string {
	let value = raw.trim().replace(/\\/g, "/");
	if (!value) return "";

	const isNegated = value.startsWith("!");
	if (isNegated) {
		value = value.slice(1).trim();
	}

	value = value.replace(/^\.\/+/, "").replace(/^\/+/, "").replace(/\/+/g, "/");

	if (!value || value === "." || value === "..") {
		return "";
	}

	if (isFolder) {
		value = value.replace(/\/+$/, "");
		if (!value || value === "." || value === "..") {
			return "";
		}
		if (!value.endsWith("/**")) {
			value = `${value}/**`;
		}
	}

	return isNegated ? `!${value}` : value;
}

interface CompiledRule {
	raw: string;
	negated: boolean;
	directoryOnly: boolean;
	regex: RegExp;
	dirPrefixRegex?: RegExp;
}

function escapeRegexChar(ch: string): string {
	return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegexFragment(glob: string): string {
	let result = "";
	let i = 0;

	while (i < glob.length) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// Handle **/ or /** or **
				if (glob[i + 2] === "/") {
					result += "(?:.*/)?";
					i += 3;
					continue;
				}
				result += ".*";
				i += 2;
				continue;
			}
			result += "[^/]*";
			i += 1;
			continue;
		}
		if (ch === "?") {
			result += "[^/]";
			i += 1;
			continue;
		}
		result += escapeRegexChar(ch);
		i += 1;
	}

	return result;
}

function compileRule(line: string, allowNegation: boolean): CompiledRule | null {
	const trimmed = line.replace(/\r$/, "").trim();
	if (!trimmed || trimmed.startsWith("#")) {
		return null;
	}

	let negated = false;
	let pattern = trimmed;
	if (allowNegation && pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1).trim();
		if (!pattern) return null;
	}

	let directoryOnly = false;
	if (pattern.endsWith("/")) {
		directoryOnly = true;
		pattern = pattern.replace(/\/+$/, "");
		if (!pattern) return null;
	}

	const hasLeadingSlash = pattern.startsWith("/");
	if (hasLeadingSlash) {
		pattern = pattern.replace(/^\/+/, "");
	}

	const anchored = hasLeadingSlash || pattern.includes("/");
	const prefix = anchored ? "^" : "(?:^|/)";

	// Directory pattern e.g. "Private/" matches directory "Private" and everything inside "Private/..."
	if (directoryOnly) {
		const frag = globToRegexFragment(pattern);
		return {
			raw: trimmed,
			negated,
			directoryOnly: true,
			regex: new RegExp(`${prefix}${frag}(?:/.*)?$`),
			dirPrefixRegex: new RegExp(`${prefix}${frag}$`),
		};
	}

	// If pattern ends with "/**", also treat the parent directory itself as ignorable during directory traversal
	let dirPrefixRegex: RegExp | undefined;
	if (pattern.endsWith("/**")) {
		const dirBase = pattern.slice(0, -3);
		if (dirBase) {
			const dirFrag = globToRegexFragment(dirBase);
			dirPrefixRegex = new RegExp(`${prefix}${dirFrag}$`);
		}
	}

	const frag = globToRegexFragment(pattern);
	return {
		raw: trimmed,
		negated,
		directoryOnly: false,
		regex: new RegExp(`${prefix}${frag}$`),
		dirPrefixRegex,
	};
}

export class IgnoreMatcher {
	private readonly builtinRules: CompiledRule[];
	private readonly userRules: CompiledRule[];

	constructor(userIgnoreText = "", options?: IgnoreMatcherOptions) {
		const builtinPatterns = getBuiltinIgnoreRules(
			Boolean(options?.syncObsidianConfig),
			options?.configDir ?? DEFAULT_CONFIG_DIR
		);
		this.builtinRules = builtinPatterns
			.map((r) => compileRule(r, false))
			.filter((r): r is CompiledRule => r !== null);

		this.userRules = userIgnoreText
			.split("\n")
			.map((line) => compileRule(line, true))
			.filter((r): r is CompiledRule => r !== null);
	}

	isIgnored(relativePath: string, isDir = false): boolean {
		const normalized = normalizeRelativePath(relativePath);
		if (!normalized) return false;

		// 1. Built-in protected rules always take precedence and cannot be negated
		for (const rule of this.builtinRules) {
			if (this.matchesRule(rule, normalized, isDir)) {
				return true;
			}
		}

		// 2. User rules evaluated in order (later matching rule wins, supporting ! negation)
		let ignored = false;
		for (const rule of this.userRules) {
			if (this.matchesRule(rule, normalized, isDir)) {
				ignored = !rule.negated;
			}
		}
		return ignored;
	}

	private matchesRule(rule: CompiledRule, normalizedPath: string, isDir: boolean): boolean {
		if (rule.regex.test(normalizedPath)) {
			return true;
		}
		if (isDir && rule.dirPrefixRegex && rule.dirPrefixRegex.test(normalizedPath)) {
			return true;
		}
		return false;
	}
}
