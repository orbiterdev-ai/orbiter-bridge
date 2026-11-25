#!/usr/bin/env node

/**
 * Orbiter Dev - PermissionRequest Hook Handler (Issue 4)
 * 
 * Handles Claude Code's native "Do you want to proceed?" prompt.
 * This fires when Claude would normally ask the user for permission.
 * 
 * If the tool matches a deny pattern:
 *   → Creates an approval request to the backend
 *   → Waits for mobile decision
 *   → Outputs JSON to allow/deny
 * 
 * If no deny match:
 *   → Auto-allows (our PreToolUse already cleared it)
 * 
 * On error:
 *   → Outputs nothing (lets Claude show native prompt as fallback)
 * 
 * JSON output goes to stdout. Logging goes to stderr.
 */

import { HookInputSchema, emitPermissionDecision } from './types.js';
import { matchesDenyList, riskLevelForDenyPattern } from './deny-patterns.js';
import { getAuthHeaders } from './utils/auth.js';
import { getOrbiterApprovalTimeoutSeconds, getOrbiterServerUrl } from './config.js';
import { pollForDecision } from './utils/poll.js';

async function main(): Promise<void> {
    const stdinData = await readStdin();

    if (!stdinData.trim()) {
        // No input - let Claude show native prompt
        process.exit(0);
    }

    let input;
    try {
        const parsed = JSON.parse(stdinData);
        input = HookInputSchema.parse(parsed);
    } catch {
        // Can't parse - let Claude show native prompt
        cleanExit();
    }

    // Check deny list
    const match = matchesDenyList(input);

    if (!match.matched) {
        // No deny match - auto-allow (PreToolUse already cleared this)
        log(`✅ Auto-allowing ${input.tool_name} (no deny match)`);
        emitPermissionDecision('allow');
        cleanExit();
    }

    // Dangerous command - route through Orbiter approval
    log(`⚠️  DENY MATCH in PermissionRequest: ${match.pattern?.description}`);
    log(`   Routing to Orbiter mobile approval...`);

    try {
        const decision = await requestMobileApproval(input, match);

        if (decision === 'approved') {
            log(`✅ APPROVED - allowing`);
            emitPermissionDecision('allow');
        } else {
            log(`❌ ${decision.toUpperCase()} - denying`);
            emitPermissionDecision('deny', `Blocked by Orbiter Dev: ${match.pattern?.description}`);
        }
    } catch (err) {
        log(`Error in approval flow: ${err}`);
        // DON'T output anything - let Claude show native prompt as fallback
        log(`Falling back to native prompt (no output)`);
    }

    process.exit(0);
}

/**
 * Request mobile approval and wait for decision.
 */
async function requestMobileApproval(
    input: ReturnType<typeof HookInputSchema.parse>,
    match: ReturnType<typeof matchesDenyList>
): Promise<string> {
    const serverUrl = getOrbiterServerUrl();
    const approvalTimeoutSeconds = getOrbiterApprovalTimeoutSeconds();
    const headers = getAuthHeaders();

    const payload = {
        action: `permission:${input.tool_name}`,
        description: `Claude Code permission request: ${summarizeToolInput(input)}`,
        diff_summary: `Matched deny pattern: ${match.pattern?.description}\nCategory: ${match.pattern?.category}`,
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

    // Handle 403 policy blocks
    if (response.status === 403) {
        const body = await response.text();
        log(`🛡️  Policy block: ${body}`);
        return 'rejected';
    }

    if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
    }

    const data = await response.json() as { data?: { id?: string } };
    const approvalId = data.data?.id;

    if (!approvalId) {
        throw new Error('No approval ID returned');
    }

    log(`Approval created: ${approvalId}, waiting...`);

    // Try SSE, fall back to polling
    try {
        const { sseWaitForDecision } = await import('./utils/sse.js');
        const result = await sseWaitForDecision(serverUrl, approvalId.toString(), approvalTimeoutSeconds);
        if (result.timedOut) return 'timeout';
        return result.status;
    } catch {
        log('SSE unavailable, polling...');
        const result = await pollForDecision(serverUrl, approvalId.toString(), approvalTimeoutSeconds);
        if (result.timedOut) return 'timeout';
        return result.status;
    }
}

function summarizeToolInput(input: ReturnType<typeof HookInputSchema.parse>): string {
    const toolInput = input.tool_input;
    if (typeof toolInput.command === 'string') return toolInput.command as string;
    if (typeof toolInput.CommandLine === 'string') return toolInput.CommandLine as string;
    const text = JSON.stringify(toolInput);
    return text.length > 200 ? text.substring(0, 200) + '...' : text;
}

function readStdin(): Promise<string> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        const timeout = setTimeout(() => resolve(''), 1000);

        process.stdin.on('data', (chunk: Buffer) => {
            clearTimeout(timeout);
            chunks.push(chunk);
        });

        process.stdin.on('end', () => {
            clearTimeout(timeout);
            resolve(Buffer.concat(chunks).toString('utf-8'));
        });

        process.stdin.on('error', () => {
            clearTimeout(timeout);
            resolve('');
        });

        process.stdin.resume();
    });
}

function log(message: string): void {
    process.stderr.write(`[orbiter:permission] ${message}\n`);
}

function cleanExit(): never {
    try { process.stdin.destroy(); } catch { /* ignore */ }
    process.exit(0);
}

// Entry point - on fatal error, output nothing (native prompt fallback)
main().catch((err) => {
    process.stderr.write(`[orbiter:permission] Fatal error: ${err}\n`);
    cleanExit();
});
