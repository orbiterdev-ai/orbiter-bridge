#!/usr/bin/env node

/**
 * Orbiter Dev - Notification Hook
 * 
 * Called by Claude Code when the Notification event fires.
 * Handles 4 notification types:
 *   - permission_prompt  → Request approval from Orbiter mobile
 *   - idle_prompt        → Notify user that agent is waiting for input
 *   - auth_success       → Log session start
 *   - elicitation_dialog / elicitation_complete / elicitation_response
 *                         → Relay Claude's elicitation state to mobile
 * 
 * This is Orbiter Dev's primary competitive advantage hook - it's the event
 * purpose-built for mobile approval relays. No competitor uses it.
 */

import {
    NotificationInputSchema,
    type NotificationInput,
    readStdin,
    cleanExit,
    createLogger
} from './types.js';
import { getAuthHeaders } from './utils/auth.js';
import { getOrbiterApprovalTimeoutSeconds, getOrbiterServerUrl } from './config.js';
import { pollForDecision } from './utils/poll.js';

const log = createLogger('notification');

async function main(): Promise<void> {
    const stdinData = await readStdin();

    if (!stdinData.trim()) {
        log('No stdin data received');
        cleanExit();
    }

    let input: NotificationInput;
    try {
        const parsed = JSON.parse(stdinData);
        input = NotificationInputSchema.parse(parsed);
    } catch (err) {
        log(`Failed to parse stdin: ${err}`);
        cleanExit();
    }

    const notificationType = input!.notification_type || 'unknown';
    log(`📬 Notification event: ${notificationType}`);
    log(`   Title: ${input!.title || 'N/A'}`);
    log(`   Message: ${input!.message || 'N/A'}`);

    switch (notificationType) {
        case 'permission_prompt':
            await handlePermissionPrompt(input!);
            break;
        case 'idle_prompt':
            await handleIdlePrompt(input!);
            break;
        case 'auth_success':
            await handleAuthSuccess(input!);
            break;
        case 'elicitation_dialog':
        case 'elicitation_complete':
        case 'elicitation_response':
            await handleElicitation(input!);
            break;
        default:
            log(`Unknown notification type: ${notificationType} - forwarding as generic`);
            await sendPushNotification(
                input!.title || 'Claude Code Notification',
                input!.message || notificationType,
                'default'
            );
            break;
    }

    cleanExit();
}

/**
 * Handle permission_prompt - Claude needs approval for a tool.
 */
async function handlePermissionPrompt(input: NotificationInput): Promise<void> {
    log('🔐 Permission prompt - submitting approval request to backend');

    const serverUrl = getOrbiterServerUrl();
    const approvalTimeoutSeconds = getOrbiterApprovalTimeoutSeconds();
    const headers = getAuthHeaders();

    const payload = {
        action: `notification:permission_prompt`,
        description: input.message || 'Claude Code needs your permission',
        diff_summary: `Session: ${input.session_id || 'unknown'}\nNotification: ${input.title || 'Permission needed'}`,
        file_count: 0,
        risk_level: 'medium',
        source_ide: 'claude_code',
        source_extension_version: '2.1.0',
        workspace_name: input.cwd || process.cwd(),
        auto_approve: false,
    };

    try {
        const response = await fetch(`${serverUrl}/api/v1/approvals`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const text = await response.text();
            log(`Server responded with ${response.status}: ${text}`);
            return;
        }

        const data = await response.json() as { data?: { id?: string } };
        const approvalId = data.data?.id;

        if (!approvalId) {
            log('No approval ID returned - skipping wait');
            return;
        }

        log(`Approval created: ${approvalId} - waiting for decision...`);

        try {
            const { sseWaitForDecision } = await import('./utils/sse.js');
            const decision = await sseWaitForDecision(serverUrl, approvalId.toString(), approvalTimeoutSeconds);

            if (decision.timedOut) {
                log(`⏰ Timed out - notification-only, not blocking`);
            } else {
                log(`Decision received: ${decision.status}`);
            }
        } catch {
            log('SSE unavailable, falling back to polling');
            const decision = await pollForDecision(serverUrl, approvalId.toString(), approvalTimeoutSeconds);
            log(`Decision via poll: ${decision.status || 'timed out'}`);
        }
    } catch (err) {
        log(`Error in permission flow: ${err}`);
    }
}

async function handleIdlePrompt(input: NotificationInput): Promise<void> {
    log('💤 Idle prompt - agent waiting for input');
    await sendPushNotification(
        '🛸 Agent Waiting',
        input.message || 'Claude Code is waiting for your input',
        'default'
    );
}

async function handleAuthSuccess(input: NotificationInput): Promise<void> {
    log('✅ Auth success - session authenticated');
    await sendHeartbeat(input, 'idle');
}

async function handleElicitation(input: NotificationInput): Promise<void> {
    log('❓ Elicitation - Claude asking question');
    await sendPushNotification(
        '❓ Claude Has a Question',
        input.message || 'Claude Code needs your answer',
        'high'
    );
}

async function sendPushNotification(
    title: string,
    body: string,
    priority: 'low' | 'default' | 'high'
): Promise<void> {
    const serverUrl = getOrbiterServerUrl();

    try {
        await fetch(`${serverUrl}/api/v1/notify`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ title, body, priority }),
        });
        log(`📱 Push sent: ${title}`);
    } catch (err) {
        log(`Push failed (non-blocking): ${err}`);
    }
}

async function sendHeartbeat(input: NotificationInput, state: string): Promise<void> {
    const serverUrl = getOrbiterServerUrl();

    try {
        await fetch(`${serverUrl}/api/v1/agent/heartbeat`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                session_id: input.session_id,
                state,
                task: input.message || 'Notification event',
            }),
        });
    } catch (err) {
        log(`Heartbeat failed (non-blocking): ${err}`);
    }
}

// --- Entry Point ---
main().catch((err) => {
    process.stderr.write(`[orbiter:notification] Fatal error: ${err}\n`);
    cleanExit();
});
