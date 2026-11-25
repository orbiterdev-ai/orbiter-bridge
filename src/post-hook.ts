#!/usr/bin/env node

/**
 * Orbiter Dev - PostToolUse Hook
 * 
 * Called by Claude Code after each tool invocation completes.
 * Sends a lightweight notification to the backend and always exits 0.
 * 
 * This is fire-and-forget: it NEVER blocks or delays the agent.
 */

import { HookInputSchema, EXIT_CODES } from './types.js';
import { getAuthHeaders } from './utils/auth.js';
import { getOrbiterServerUrl } from './config.js';

async function main(): Promise<void> {
    // Read stdin
    const stdinData = await readStdin();

    if (!stdinData.trim()) {
        process.exit(EXIT_CODES.ALLOW);
    }

    let input;
    try {
        const parsed = JSON.parse(stdinData);
        input = HookInputSchema.parse(parsed);
    } catch {
        // Can't parse - just exit silently
        process.exit(EXIT_CODES.ALLOW);
    }

    // Fire-and-forget notification - don't await
    sendNotification(input).catch((err) => {
        log(`Notification failed (non-blocking): ${err}`);
    });

    // Always allow - post-hook never blocks
    process.exit(EXIT_CODES.ALLOW);
}

/**
 * Send a lightweight tool completion notification to the backend.
 */
async function sendNotification(input: ReturnType<typeof HookInputSchema.parse>): Promise<void> {
    const serverUrl = getOrbiterServerUrl();

    const payload = {
        title: `Tool completed: ${input.tool_name}`,
        body: summarizeResult(input),
        priority: 'low',
    };

    await fetch(`${serverUrl}/api/v1/notify`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload),
    });
}

/**
 * Create a brief summary of the tool result.
 */
function summarizeResult(input: ReturnType<typeof HookInputSchema.parse>): string {
    const toolInput = input.tool_input;

    // Extract command if present
    const command = (toolInput.command || toolInput.CommandLine || '') as string;
    const commandHint = command ? ` - ${command.substring(0, 100)}` : '';

    // Extract result if present
    const result = input.tool_response ?? input.tool_result;
    if (typeof result === 'string') {
        const preview = result.substring(0, 200);
        return `${input.tool_name}${commandHint}: ${preview}`;
    }

    return `${input.tool_name}${commandHint} completed`;
}

/**
 * Read all of stdin.
 */
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
    process.stderr.write(`[orbiter:post-hook] ${message}\n`);
}

// --- Entry Point ---
main().catch(() => {
    process.exit(EXIT_CODES.ALLOW); // Never crash
});
