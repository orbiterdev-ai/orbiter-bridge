import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DenyListConfigSchema, DenyMatch, DenyPattern, HookInput } from './types.js';

export type OrbiterApprovalRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Deny Pattern Matcher
 * 
 * Loads deny patterns from the bundled deny-patterns.json,
 * merges any user overrides from ~/.orbiter/deny-patterns.json,
 * and matches tool invocations against the combined list.
 */

let cachedPatterns: DenyPattern[] | null = null;

/**
 * Load deny patterns from bundled defaults + user overrides.
 */
export function loadDenyPatterns(): DenyPattern[] {
    if (cachedPatterns) return cachedPatterns;

    const patterns: DenyPattern[] = [];

    // 1. Load bundled defaults
    const bundledPath = path.resolve(__dirname, '..', 'deny-patterns.json');
    try {
        const raw = fs.readFileSync(bundledPath, 'utf-8');
        const config = DenyListConfigSchema.parse(JSON.parse(raw));
        patterns.push(...config.patterns);
    } catch (err) {
        process.stderr.write(`[orbiter] Warning: Could not load bundled deny patterns: ${err}\n`);
    }

    // 2. Merge user overrides from ~/.orbiter/deny-patterns.json
    const userPath = path.join(
        os.homedir(),
        '.orbiter',
        'deny-patterns.json'
    );

    if (fs.existsSync(userPath)) {
        try {
            const raw = fs.readFileSync(userPath, 'utf-8');
            const config = DenyListConfigSchema.parse(JSON.parse(raw));
            patterns.push(...config.patterns);
            process.stderr.write(`[orbiter] Loaded ${config.patterns.length} user deny patterns\n`);
        } catch (err) {
            process.stderr.write(`[orbiter] Warning: Could not load user deny patterns: ${err}\n`);
        }
    }

    cachedPatterns = patterns;
    return patterns;
}

/**
 * Clear the cached patterns (useful for testing).
 */
export function clearPatternCache(): void {
    cachedPatterns = null;
}

/**
 * Extract searchable text from a tool invocation.
 * Flattens tool_name and all tool_input values into a single string.
 */
export function extractSearchText(input: HookInput): string {
    const parts: string[] = [input.tool_name];

    if (input.tool_input) {
        for (const value of Object.values(input.tool_input)) {
            if (typeof value === 'string') {
                parts.push(value);
            } else if (value !== null && value !== undefined) {
                parts.push(JSON.stringify(value));
            }
        }
    }

    return parts.join(' ');
}

/**
 * Check if a tool invocation matches any deny pattern.
 */
export function matchesDenyList(input: HookInput): DenyMatch {
    const patterns = loadDenyPatterns();
    const searchText = extractSearchText(input);

    for (const pattern of patterns) {
        try {
            const regex = new RegExp(pattern.pattern, 'i');
            if (regex.test(searchText)) {
                return {
                    matched: true,
                    pattern,
                    matchedText: searchText,
                };
            }
        } catch {
            // Invalid regex - skip silently
            process.stderr.write(`[orbiter] Warning: Invalid deny pattern regex: ${pattern.pattern}\n`);
        }
    }

    return {
        matched: false,
        pattern: null,
        matchedText: searchText,
    };
}

export function riskLevelForDenyPattern(pattern: DenyPattern | null | undefined): OrbiterApprovalRiskLevel {
    if (!pattern) return 'low';
    if (pattern.severity === 'critical') return 'critical';
    if (pattern.severity === 'high') return 'high';
    return 'medium';
}
