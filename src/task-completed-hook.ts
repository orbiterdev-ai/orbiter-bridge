#!/usr/bin/env node

/**
 * Orbiter Dev - TaskCompleted Hook
 * 
 * Pushes "task done!" notification to mobile. Fire-and-forget.
 * The #1 most requested feature: "tell me when it's done."
 */

import {
    TaskCompletedInputSchema,
    type TaskCompletedInput,
    readStdin,
    cleanExit,
    createLogger
} from './types.js';
import { getAuthHeaders } from './utils/auth.js';
import { getOrbiterServerUrl } from './config.js';

const log = createLogger('task-completed');

async function main(): Promise<void> {
    const stdinData = await readStdin();

    if (!stdinData.trim()) {
        log('No stdin data');
        cleanExit();
    }

    let input: TaskCompletedInput;
    try {
        const parsed = JSON.parse(stdinData);
        input = TaskCompletedInputSchema.parse(parsed);
    } catch (err) {
        log(`Failed to parse stdin: ${err}`);
        cleanExit();
    }

    log('✅ Task completed event received');
    log(`   Summary: ${input!.task_summary || 'N/A'}`);
    log(`   Duration: ${input!.duration_ms ? `${Math.round(input!.duration_ms / 1000)}s` : 'N/A'}`);
    log(`   Files: ${input!.files_modified?.length || 0}`);

    await sendTaskCompletedNotification(input!);
    await sendHeartbeat(input!, 'idle');

    cleanExit();
}

async function sendTaskCompletedNotification(input: TaskCompletedInput): Promise<void> {
    const serverUrl = getOrbiterServerUrl();

    const duration = input.duration_ms ? formatDuration(input.duration_ms) : '';
    const fileCount = input.files_modified?.length || 0;
    const fileHint = fileCount > 0 ? ` • ${fileCount} file${fileCount === 1 ? '' : 's'} modified` : '';

    const title = '✅ Task Complete';
    const body = [
        input.task_summary || 'Agent finished working',
        duration ? `⏱️ ${duration}` : '',
        fileHint,
    ].filter(Boolean).join('\n');

    try {
        await fetch(`${serverUrl}/api/v1/notify`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ title, body, priority: 'high' }),
        });
        log(`📱 Push sent: ${title}`);
    } catch (err) {
        log(`Push failed (non-blocking): ${err}`);
    }
}

async function sendHeartbeat(input: TaskCompletedInput, state: string): Promise<void> {
    const serverUrl = getOrbiterServerUrl();

    try {
        await fetch(`${serverUrl}/api/v1/agent/heartbeat`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                session_id: input.session_id,
                state,
                task: input.task_summary || 'Task completed',
            }),
        });
    } catch (err) {
        log(`Heartbeat failed (non-blocking): ${err}`);
    }
}

function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
}

// --- Entry Point ---
main().catch((err) => {
    process.stderr.write(`[orbiter:task-completed] Fatal error: ${err}\n`);
    cleanExit();
});
