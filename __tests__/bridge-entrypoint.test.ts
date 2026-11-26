import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

function startSseTestServer(options: { statusCode?: number } = {}) {
    const statusCode = options.statusCode ?? 200;
    const receivedHeaders: Array<http.IncomingHttpHeaders> = [];
    const activeResponses = new Set<http.ServerResponse>();

    const server = http.createServer((req, res) => {
        if (req.url === '/api/v1/mcp/sse') {
            receivedHeaders.push({ ...req.headers });
            if (statusCode !== 200) {
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
                return;
            }
            activeResponses.add(res);
            res.on('close', () => activeResponses.delete(res));
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            res.write('event: endpoint\ndata: /api/v1/mcp/messages\n\n');
            return;
        }
        res.writeHead(404);
        res.end();
    });

    return new Promise<{
        url: string;
        receivedHeaders: Array<http.IncomingHttpHeaders>;
        close: () => Promise<void>;
    }>((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Expected numeric server port'));
                return;
            }
            resolve({
                url: `http://127.0.0.1:${address.port}`,
                receivedHeaders,
                close: () =>
                    new Promise<void>((done) => {
                        for (const res of activeResponses) {
                            res.end();
                        }
                        activeResponses.clear();
                        server.close(() => done());
                    }),
            });
        });
    });
}

function waitForCondition(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (predicate()) {
                clearInterval(timer);
                resolve();
            } else if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                reject(new Error('Timed out waiting for bridge SSE connection'));
            }
        }, 25);
    });
}

describe('F08: shipped orbiter-bridge index.js executable (eventsource v4)', () => {
    const entrypoint = path.resolve(__dirname, '..', 'index.js');

    it('starts, connects to loopback SSE using eventsource v4 fetch auth headers, and leaks zero credentials', async () => {
        const sentinelToken = 'orb_secret_bridge_test_token_never_log_987654321';
        const machineId = 'bridge-test-machine-01';
        const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orbiter-bridge-home-'));
        const sseServer = await startSseTestServer({ statusCode: 200 });

        let stdout = '';
        let stderr = '';
        let exitCode: number | null = null;

        const child = spawn(process.execPath, [entrypoint], {
            cwd: isolatedHome,
            env: {
                ...process.env,
                HOME: isolatedHome,
                USERPROFILE: isolatedHome,
                ORBITER_URL: sseServer.url,
                ORBITER_TOKEN: sentinelToken,
                ORBITER_MACHINE_ID: machineId,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.on('exit', (code) => { exitCode = code; });

        try {
            await waitForCondition(
                () => sseServer.receivedHeaders.length > 0 && stderr.includes('Remote endpoint established'),
                5000
            );

            expect(exitCode).toBeNull();
            expect(sseServer.receivedHeaders.length).toBeGreaterThanOrEqual(1);
            const reqHeaders = sseServer.receivedHeaders[0];
            expect(reqHeaders['authorization']).toBe(`Bearer ${sentinelToken}`);
            expect(reqHeaders['x-orbiter-machine-id']).toBe(machineId);
            expect(reqHeaders['accept']).toBe('text/event-stream');

            // Verify zero credential leakage and clean stdio stdout framing
            expect(stdout).not.toContain(sentinelToken);
            expect(stderr).not.toContain(sentinelToken);
            expect(stderr).not.toMatch(/TypeError/i);
            expect(stderr).toContain('Orbiter Bridge: Stdio Transport Active');
            expect(stdout.trim()).toBe('');
        } finally {
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                if (child.exitCode !== null || child.killed) {
                    child.once('exit', () => resolve());
                    setTimeout(resolve, 1000);
                } else {
                    resolve();
                }
            });
            await sseServer.close();
            fs.rmSync(isolatedHome, { recursive: true, force: true });
        }
    });

    it('handles SSE HTTP error responses without leaking credentials to stdout or stderr', async () => {
        const sentinelToken = 'orb_secret_bridge_err_token_never_log_123456789';
        const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orbiter-bridge-err-'));
        const sseServer = await startSseTestServer({ statusCode: 401 });

        let stdout = '';
        let stderr = '';

        const child = spawn(process.execPath, [entrypoint], {
            cwd: isolatedHome,
            env: {
                ...process.env,
                HOME: isolatedHome,
                USERPROFILE: isolatedHome,
                ORBITER_URL: sseServer.url,
                ORBITER_TOKEN: sentinelToken,
                ORBITER_MACHINE_ID: 'bridge-err-machine',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });

        try {
            await waitForCondition(
                () => sseServer.receivedHeaders.length > 0 && stderr.includes('SSE Error'),
                5000
            );

            expect(sseServer.receivedHeaders[0]['authorization']).toBe(`Bearer ${sentinelToken}`);
            expect(stdout).not.toContain(sentinelToken);
            expect(stderr).not.toContain(sentinelToken);
            expect(stderr).toContain('HTTP 401');
            expect(stderr).not.toMatch(/TypeError/i);
        } finally {
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => {
                child.once('exit', () => resolve());
                setTimeout(resolve, 1000);
            });
            await sseServer.close();
            fs.rmSync(isolatedHome, { recursive: true, force: true });
        }
    });
});
