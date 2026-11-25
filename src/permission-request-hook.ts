#!/usr/bin/env node

/**
 * Orbiter Dev - PermissionRequest Hook
 * 
 * More powerful than PreToolUse - fires at Claude's native permission dialog.
 * Supports input rewriting, dynamic permission updates, and mobile approval.
 */

import {
    PermissionRequestInputSchema,
    type PermissionRequestInput,
    emitPermissionDecision,
    readStdin,
    cleanExit,
    createLogger
} from './types.js';
import { matchesDenyList, riskLevelForDenyPattern } from './deny-patterns.js';
import { getAuthHeaders } from './utils/auth.js';
import { pollForDecision } from './utils/poll.js';
import { getOrbiterApprovalTimeoutSeconds, getOrbiterServerUrl } from './config.js';

const log = createLogger('permission-req');

async function main(): Promise<void> {
    const stdinData = await readStdin();

    if (!stdinData.trim()) {
        log('No stdin data - falling back to native prompt');
        cleanExit();
    }

    let input: PermissionRequestInput;
    try {
        const parsed = JSON.parse(stdinData);
        input = PermissionRequestInputSchema.parse(parsed);
    } catch (err) {
        log(`Failed to parse stdin: ${err}`);
        cleanExit();
    }

    log(`🔑 PermissionRequest for tool: ${input!.tool_name}`);

    // Step 1: Check deny list (fast path - no network)
    const denyInput = {
        tool_name: input!.tool_name,
        tool_input: input!.tool_input,
    };
    const match = matchesDenyList(denyInput);

    if (!match.matched) {
        log(`✅ ALLOW: ${input!.tool_name} (no deny pattern match)`);
        emitPermissionDecision('allow', `Safe: ${input!.tool_name}`);
        cleanExit();
    }

    // Step 2: Risky command - request approval from mobile
    log(`⚠️  DENY MATCH: ${match.pattern?.description}`);
    log(`   Category: ${match.pattern?.category}`);

    try {
        const result = await requestApproval(input!, match);

        if (result.decision === 'approved') {
            log(`✅ APPROVED - allowing with${result.sanitizedInput ? ' sanitized input' : ' original input'}`);
            emitPermissionDecision('allow', result.reason || 'Approved via Orbiter Dev', result.sanitizedInput);
        } else {
            log(`❌ ${result.decision.toUpperCase()} - denying`);
            emitPermissionDecision('deny', result.reason || `Blocked: ${match.pattern?.description}`);
        }
    } catch (err) {
        log(`Error in approval flow: ${err}`);
        emitPermissionDecision('deny', 'Orbiter could not determine - blocking risky command');
    }

    cleanExit();
}

interface ApprovalResult {
    decision: 'approved' | 'rejected' | 'timeout' | 'policy_blocked';
    reason: string;
    sanitizedInput?: Record<string, unknown>;
}

async function requestApproval(
    input: PermissionRequestInput,
    match: ReturnType<typeof matchesDenyList>
): Promise<ApprovalResult> {
    const serverUrl = getOrbiterServerUrl();
    const approvalTimeoutSeconds = getOrbiterApprovalTimeoutSeconds();
    const headers = getAuthHeaders();
    const command = extractCommand(input);

    const payload = {
        action: `permission:${input.tool_name}`,
        description: `Permission request: ${command || input.tool_name}`,
        diff_summary: [
            `Tool: ${input.tool_name}`,
            `Pattern: ${match.pattern?.description}`,
            `Category: ${match.pattern?.category}`,
            `Agent: ${input.agent_id || 'primary'}`,
            command ? `Command: ${command}` : '',
        ].filter(Boolean).join('\n'),
        file_count: 0,
        risk_level: riskLevelForDenyPattern(match.pattern),
        source_ide: 'claude_code',
        source_extension_version: '2.1.0',
        workspace_name: input.cwd || process.cwd(),
        auto_approve: false,
    };

    const response = await fetch(`${serverUrl}/api/v1/approvals`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });

    if (response.status === 403) {
        const body = await response.text();
        log(`🛡️ 403 - policy block: ${body}`);
        return { decision: 'policy_blocked', reason: `Policy: ${body}` };
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

    log(`Approval created: ${approvalId} - waiting...`);

    try {
        const { sseWaitForDecision } = await import('./utils/sse.js');
        const decision = await sseWaitForDecision(serverUrl, approvalId.toString(), approvalTimeoutSeconds);

        if (decision.timedOut) {
            return { decision: 'timeout', reason: `Timed out after ${approvalTimeoutSeconds}s` };
        }

        return {
            decision: decision.status === 'approved' ? 'approved' : 'rejected',
            reason: decision.notes || (decision.status === 'approved'
                ? 'Approved via Orbiter Dev mobile'
                : 'Rejected via Orbiter Dev mobile'),
        };
    } catch {
        log('SSE unavailable - polling');
        const decision = await pollForDecision(serverUrl, approvalId.toString(), approvalTimeoutSeconds);

        if (decision.timedOut) {
            return { decision: 'timeout', reason: `Timed out after ${approvalTimeoutSeconds}s` };
        }

        return {
            decision: decision.status === 'approved' ? 'approved' : 'rejected',
            reason: decision.notes || (decision.status === 'approved'
                ? 'Approved via Orbiter Dev mobile'
                : 'Rejected via Orbiter Dev mobile'),
        };
    }
}

function extractCommand(input: PermissionRequestInput): string {
    const ti = input.tool_input;
    if (typeof ti.command === 'string') return ti.command;
    if (typeof ti.CommandLine === 'string') return ti.CommandLine;
    if (typeof ti.query === 'string') return `SQL: ${(ti.query as string).substring(0, 200)}`;
    return '';
}

// --- Entry Point ---
main().catch((err) => {
    process.stderr.write(`[orbiter:permission-req] Fatal error: ${err}\n`);
    emitPermissionDecision('deny', 'Orbiter hook crashed - blocking for safety');
    cleanExit();
});
