#!/usr/bin/env node

/**
 * Orbiter Dev - Session Lifecycle Hooks
 * 
 * Handles SessionStart and SessionEnd events.
 * Fire-and-forget: never blocks Claude's execution.
 */

import {
    SessionInputSchema,
    type SessionInput,
    readStdin,
    cleanExit,
    createLogger
} from './types.js';
import { getAuthHeaders } from './utils/auth.js';
import { getOrbiterServerUrl } from './config.js';

const log = createLogger('session');

async function main(): Promise<void> {
    const stdinData = await readStdin();

    if (!stdinData.trim()) {
        log('No stdin data');
        cleanExit();
    }

    let input: SessionInput;
    try {
        const parsed = JSON.parse(stdinData);
        input = SessionInputSchema.parse(parsed);
    } catch (err) {
        log(`Failed to parse stdin: ${err}`);
        cleanExit();
    }

    const eventName = input!.hook_event_name || 'unknown';
    log(`📡 Session event: ${eventName}`);

    switch (eventName) {
        case 'SessionStart':
            await handleSessionStart(input!);
            break;
        case 'SessionEnd':
            await handleSessionEnd(input!);
            break;
        default:
            log(`Unknown session event: ${eventName}`);
            break;
    }

    cleanExit();
}

async function handleSessionStart(input: SessionInput): Promise<void> {
    log(`🚀 Session started: ${input.session_id || 'unknown'}`);
    log(`   CWD: ${input.cwd || 'N/A'}`);
    await sendHeartbeat(input, 'working', 'Session started');
}

/**
 * SessionEnd reasons that represent a REAL end the user should hear about. Claude Code
 * also fires SessionEnd with reason 'clear' for the PREVIOUS session the moment a new
 * chat starts (and 'other' for transient internal rollovers) - pushing on those produced
 * phantom "Session Ended" notifications exactly when the user was STARTING work.
 * The silent heartbeat still records every end; only the push is gated.
 */
const SESSION_END_PUSH_REASONS = new Set(['logout', 'prompt_input_exit']);

async function handleSessionEnd(input: SessionInput): Promise<void> {
    const reason = input.reason || 'unknown';
    log(`🏁 Session ended: ${input.session_id || 'unknown'} (reason: ${reason})`);
    await sendHeartbeat(input, 'idle', `Session ended (${reason})`);

    if (!SESSION_END_PUSH_REASONS.has(reason)) {
        log(`Push suppressed for transient session end (reason: ${reason})`);
        return;
    }

    await sendPushNotification(
        '🏁 Session Ended',
        `Claude Code session ended${input.cwd ? ` in ${getWorkspaceName(input.cwd)}` : ''}`,
        'low'
    );
}

async function sendHeartbeat(input: SessionInput, state: string, task: string): Promise<void> {
    const serverUrl = getOrbiterServerUrl();
    try {
        await fetch(`${serverUrl}/api/v1/agent/heartbeat`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ session_id: input.session_id, state, task }),
        });
        log(`Heartbeat: ${state}`);
    } catch (err) {
        log(`Heartbeat failed (non-blocking): ${err}`);
    }
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
    } catch (err) {
        log(`Push failed (non-blocking): ${err}`);
    }
}

function getWorkspaceName(cwd: string): string {
    const parts = cwd.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || cwd;
}

// --- Entry Point ---
main().catch((err) => {
    process.stderr.write(`[orbiter:session] Fatal error: ${err}\n`);
    cleanExit();
});
