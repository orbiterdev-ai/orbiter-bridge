#!/usr/bin/env node

/**
 * Orbiter Dev - PreToolUse Hook (v2 - JSON Output)
 * 
 * Called by Claude Code before each tool invocation.
 * Reads tool invocation JSON from stdin, checks against deny list,
 * and outputs a JSON permission decision to stdout.
 * 
 * Claude Code v2.1+ JSON protocol:
 *   stdout JSON with permissionDecision: "allow" → skip native prompt
 *   stdout JSON with permissionDecision: "deny"  → block tool
 *   stdout JSON with permissionDecision: "ask"   → fall back to native prompt
 * 
 * All logging goes to stderr (Claude Code ignores it).
 * All exit codes are 0 - the JSON decision handles allow/deny.
 * 
 * SAFETY: On any error, outputs permissionDecision: "ask" to fall back
 * to Claude Code's native permission prompt rather than silently allowing.
 */

import { HookInputSchema, emitPreToolDecision } from './types.js';
import { matchesDenyList, riskLevelForDenyPattern } from './deny-patterns.js';
import { getAuthHeaders } from './utils/auth.js';
import { pollForDecision } from './utils/poll.js';
import { getOrbiterApprovalTimeoutSeconds, getOrbiterServerUrl } from './config.js';

async function main(): Promise<void> {
    // Read stdin
    const stdinData = await readStdin();

    if (!stdinData.trim()) {
        log('No stdin data received, asking');
        emitPreToolDecision('ask', 'No hook input received');
        cleanExit();
    }

    // Parse input
    let input;
    try {
        const parsed = JSON.parse(stdinData);
        input = HookInputSchema.parse(parsed);
    } catch (err) {
        log(`Failed to parse stdin: ${err}`);
        emitPreToolDecision('ask', 'Could not parse hook input');
        cleanExit();
    }

    // Check deny list
    const match = matchesDenyList(input);

    if (!match.matched) {
        log(`✅ ALLOW: ${input.tool_name} (no deny match)`);
        emitPreToolDecision('allow', `Safe command: ${input.tool_name}`);
        cleanExit();
    }

    // Dangerous command detected - request approval
    log(`⚠️  DENY MATCH: ${match.pattern?.description} [${match.pattern?.category}]`);
    log(`   Tool: ${input.tool_name}`);
    log(`   Pattern: ${match.pattern?.pattern}`);
    log(`   Requesting mobile approval...`);

    try {
        const result = await requestApproval(input, match);

        if (result.decision === 'approved') {
            log(`✅ APPROVED by mobile - allowing tool execution`);
            emitPreToolDecision('allow', result.reason || 'Approved via Orbiter Dev mobile');
            cleanExit();
        } else {
            log(`❌ ${result.decision.toUpperCase()} - blocking tool execution`);
            emitPreToolDecision('deny', result.reason || `Blocked by Orbiter Dev: ${match.pattern?.description}`);
            cleanExit();
        }
    } catch (err) {
        log(`Error in approval flow: ${err}`);
        // Fail-safe: ask Claude to show native prompt
        log(`Falling back to ASK (native prompt)`);
        emitPreToolDecision('ask', 'Orbiter could not determine - asking user');
        cleanExit();
    }
}

interface ApprovalResult {
    decision: 'approved' | 'rejected' | 'timeout' | 'policy_blocked';
    reason: string;
}

/**
 * Submit an approval request to the backend and wait for decision.
 * Handles 403 policy blocks and signature requirements.
 */
async function requestApproval(
    input: ReturnType<typeof HookInputSchema.parse>,
    match: ReturnType<typeof matchesDenyList>
): Promise<ApprovalResult> {
    const serverUrl = getOrbiterServerUrl();
    const approvalTimeoutSeconds = getOrbiterApprovalTimeoutSeconds();
    const headers = getAuthHeaders();

    // Build payload matching the backend's approval request schema
    const payload = {
        action: `hook:${input.tool_name}`,
        description: `Claude Code wants to execute: ${summarizeToolInput(input)}`,
        diff_summary: `Matched deny pattern: ${match.pattern?.description}\nCategory: ${match.pattern?.category}\nPattern: ${match.pattern?.pattern}`,
        file_count: 0,
        risk_level: riskLevelForDenyPattern(match.pattern),
        source_ide: 'claude_code',
        source_extension_version: '2.0.0',
        workspace_name: process.cwd(),
        auto_approve: false,
    };

    const response = await fetch(`${serverUrl}/api/v1/approvals`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    // ─── Handle 403 responses (Issues 2 & 3) ───
    if (response.status === 403) {
        const body = await response.text();
        let errorMessage = body;

        try {
            const parsed = JSON.parse(body);
            errorMessage = parsed.error || parsed.message || body;
        } catch { /* use raw body */ }

        // Policy block - this is NOT an error, it's a deliberate policy decision
        if (errorMessage.includes('blocked by policy') || errorMessage.includes('policy')) {
            log(`🛡️  POLICY BLOCK: ${errorMessage}`);
            return {
                decision: 'policy_blocked',
                reason: `Blocked by server policy: ${errorMessage}`,
            };
        }

        // Signature requirement - can't proceed via API for this risk level
        if (errorMessage.includes('signature') || errorMessage.includes('cryptographic')) {
            log(`🔐 SIGNATURE REQUIRED: ${errorMessage}`);
            return {
                decision: 'policy_blocked',
                reason: `High-risk action requires cryptographic signature from mobile app. ${errorMessage}`,
            };
        }

        // Other 403 - treat as auth error, but still block dangerous command
        log(`⛔ 403 Forbidden: ${errorMessage}`);
        return {
            decision: 'rejected',
            reason: `Server denied request (403): ${errorMessage}`,
        };
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Server responded with ${response.status}: ${text}`);
    }

    const data = await response.json() as { data?: { id?: string } };
    const approvalId = data.data?.id;

    if (!approvalId) {
        throw new Error('No approval ID returned from server');
    }

    log(`Approval created: ${approvalId}`);
    log(`Waiting up to ${approvalTimeoutSeconds}s for decision...`);

    // Try SSE first, fall back to polling
    try {
        const { sseWaitForDecision } = await import('./utils/sse.js');
        const decision = await sseWaitForDecision(serverUrl, approvalId.toString(), approvalTimeoutSeconds);

        if (decision.timedOut) {
            log(`⏰ Timed out waiting for approval - blocking`);
            return { decision: 'timeout', reason: `No approval received within ${approvalTimeoutSeconds}s` };
        }

        return {
            decision: decision.status === 'approved' ? 'approved' : 'rejected',
            reason: decision.notes || (decision.status === 'approved'
                ? 'Approved via Orbiter Dev mobile'
                : 'Rejected via Orbiter Dev mobile'),
        };
    } catch {
        // SSE failed - fall back to polling
        log('SSE unavailable, falling back to polling');
        const decision = await pollForDecision(
            serverUrl,
            approvalId.toString(),
            approvalTimeoutSeconds
        );

        if (decision.timedOut) {
            log(`⏰ Timed out waiting for approval - blocking`);
            return { decision: 'timeout', reason: `No approval received within ${approvalTimeoutSeconds}s` };
        }

        return {
            decision: decision.status === 'approved' ? 'approved' : 'rejected',
            reason: decision.notes || (decision.status === 'approved'
                ? 'Approved via Orbiter Dev mobile'
                : 'Rejected via Orbiter Dev mobile'),
        };
    }
}

/**
 * Create a human-readable summary of the tool input.
 */
function summarizeToolInput(input: ReturnType<typeof HookInputSchema.parse>): string {
    const toolInput = input.tool_input;

    if (typeof toolInput.command === 'string') {
        return toolInput.command as string;
    }
    if (typeof toolInput.CommandLine === 'string') {
        return toolInput.CommandLine as string;
    }
    if (typeof toolInput.query === 'string') {
        return `SQL: ${(toolInput.query as string).substring(0, 200)}`;
    }

    const text = JSON.stringify(toolInput);
    return text.length > 300 ? text.substring(0, 300) + '...' : text;
}

/**
 * Cleanly exit process - destroy stdin handles first to avoid
 * UV_HANDLE_CLOSING assertion crash on Windows.
 */
function cleanExit(): never {
    try { process.stdin.destroy(); } catch { /* ignore */ }
    process.exit(0);
}

/**
 * Read all of stdin as a string.
 */
function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const timeout = setTimeout(() => {
            resolve('');
        }, 1000);

        process.stdin.on('data', (chunk: Buffer) => {
            clearTimeout(timeout);
            chunks.push(chunk);
        });

        process.stdin.on('end', () => {
            clearTimeout(timeout);
            resolve(Buffer.concat(chunks).toString('utf-8'));
        });

        process.stdin.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        process.stdin.resume();
    });
}

/**
 * Log to stderr (Claude Code reads stdout for JSON decisions, ignores stderr).
 */
function log(message: string): void {
    process.stderr.write(`[orbiter:pre-check] ${message}\n`);
}

// --- Entry Point ---
// Wrap in global catch - emit "ask" on fatal error (fail-safe to native prompt)
main().catch((err) => {
    process.stderr.write(`[orbiter:pre-check] Fatal error: ${err}\n`);
    emitPreToolDecision('ask', 'Orbiter hook crashed - asking user');
    cleanExit();
});
