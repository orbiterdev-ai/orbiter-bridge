import { getAuthHeaders } from './auth';

/**
 * SSE Client for Approval Waiting.
 *
 * Opens a Server-Sent Events connection to the backend SSE endpoint
 * and resolves when a terminal decision, timeout, or close event arrives.
 */

export interface SSEDecision {
    status: 'approved' | 'rejected' | 'timeout';
    notes: string;
    timedOut: boolean;
    method: 'sse' | 'poll';
}

const SSE_RETRY_CONFIG = {
    baseDelayMs: 5_000,
    maxDelayMs: 30_000,
    maxAttempts: 10,
    jitterFactor: 0.3,
} as const;

function calculateRetryDelay(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitterFactor } = SSE_RETRY_CONFIG;
    const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
    const jitter = exponentialDelay * jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(exponentialDelay + jitter));
}

export async function sseWaitForDecision(
    serverUrl: string,
    approvalId: string,
    timeoutSeconds: number = 300
): Promise<SSEDecision> {
    let attempt = 0;
    const deadline = Date.now() + (Math.max(1, timeoutSeconds) * 1000);

    while (attempt < SSE_RETRY_CONFIG.maxAttempts && Date.now() < deadline) {
        try {
            const remainingMs = Math.max(1_000, deadline - Date.now());
            const result = await sseConnect(serverUrl, approvalId, remainingMs);
            return result;
        } catch (err) {
            attempt++;

            if (err instanceof SSETerminalError) {
                throw err;
            }

            if (attempt >= SSE_RETRY_CONFIG.maxAttempts || Date.now() >= deadline) {
                process.stderr.write(
                    `[orbiter] SSE: All ${SSE_RETRY_CONFIG.maxAttempts} retry attempts exhausted for approval ${approvalId}\n`
                );
                throw err;
            }

            const delay = calculateRetryDelay(attempt - 1);
            process.stderr.write(
                `[orbiter] SSE: Connection lost, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${SSE_RETRY_CONFIG.maxAttempts})...\n`
            );

            await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
        }
    }

    return {
        status: 'timeout',
        notes: `No SSE decision received within ${timeoutSeconds}s`,
        timedOut: true,
        method: 'sse',
    };
}

class SSETerminalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SSETerminalError';
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sseConnect(
    serverUrl: string,
    approvalId: string,
    timeoutMs: number
): Promise<SSEDecision> {
    const url = `${serverUrl}/api/v1/approvals/${approvalId}/sse`;
    const headers = getAuthHeaders();

    return new Promise<SSEDecision>((resolve, reject) => {
        const controller = new AbortController();

        const safetyTimeout = setTimeout(() => {
            controller.abort();
            resolve({
                status: 'timeout',
                notes: 'Client-side safety timeout',
                timedOut: true,
                method: 'sse',
            });
        }, timeoutMs);

        fetch(url, {
            headers: {
                ...headers,
                Accept: 'text/event-stream',
            },
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) {
                    if (response.status >= 400 && response.status < 500) {
                        throw new SSETerminalError(
                            `SSE connection failed with ${response.status} - not retryable`
                        );
                    }
                    throw new Error(`SSE connection failed: ${response.status}`);
                }

                if (!response.body) {
                    throw new Error('SSE response has no body');
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        throw new Error('SSE stream ended unexpectedly');
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const events = parseSSEBuffer(buffer);
                    buffer = events.remaining;

                    for (const event of events.parsed) {
                        if (event.type === 'decision') {
                            clearTimeout(safetyTimeout);
                            controller.abort();
                            const status = event.data.status as SSEDecision['status'];
                            resolve({
                                status,
                                notes: event.data.notes || '',
                                timedOut: false,
                                method: 'sse',
                            });
                            return;
                        }

                        if (event.type === 'timeout') {
                            clearTimeout(safetyTimeout);
                            controller.abort();
                            resolve({
                                status: 'timeout',
                                notes: event.data.message || 'Server timeout',
                                timedOut: true,
                                method: 'sse',
                            });
                            return;
                        }

                        if (event.type === 'closed') {
                            clearTimeout(safetyTimeout);
                            controller.abort();
                            resolve({
                                status: 'timeout',
                                notes: event.data.reason || 'Channel closed',
                                timedOut: true,
                                method: 'sse',
                            });
                            return;
                        }

                        if (event.type === 'reminder') {
                            process.stderr.write(`[orbiter] Reminder: ${event.data.message}\n`);
                        }
                    }
                }
            })
            .catch((err) => {
                clearTimeout(safetyTimeout);
                if (err.name === 'AbortError') {
                    return;
                }
                reject(err);
            });
    });
}

function parseSSEBuffer(buffer: string): {
    parsed: Array<{ type: string; data: Record<string, string> }>;
    remaining: string;
} {
    const parsed: Array<{ type: string; data: Record<string, string> }> = [];
    const blocks = buffer.split('\n\n');
    const remaining = blocks.pop() || '';

    for (const block of blocks) {
        if (!block.trim()) continue;

        let eventType = 'message';
        const dataLines: string[] = [];

        for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
                dataLines.push(line.slice(6));
            }
        }

        if (dataLines.length > 0) {
            try {
                const data = JSON.parse(dataLines.join('\n'));
                parsed.push({ type: eventType, data });
            } catch {
                parsed.push({
                    type: eventType,
                    data: { message: dataLines.join('\n') },
                });
            }
        }
    }

    return { parsed, remaining };
}
