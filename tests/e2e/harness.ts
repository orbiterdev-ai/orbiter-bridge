import { spawn } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

interface HookResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    json: any;
}

export class MockIDEHarness {
    private server: any;
    private requests: any[] = [];
    private decisions: Map<string, any> = new Map();
    private port: number;
    private distDir: string;

    constructor(port = 9999) {
        this.port = port;
        this.distDir = join(__dirname, '../../dist');
    }

    async startMockServer() {
        this.requests = [];
        this.decisions.clear();
        this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                const payload = body ? JSON.parse(body) : {};
                this.requests.push({
                    method: req.method,
                    url: req.url,
                    body: payload,
                    headers: req.headers
                });

                // Handle GET /api/v1/approvals/:id/sse
                if (req.method === 'GET' && req.url?.endsWith('/sse')) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'SSE not supported in harness' }));
                    return;
                }

                // Handle GET /api/v1/approvals/:id
                if (req.method === 'GET' && req.url?.startsWith('/api/v1/approvals/')) {
                    const id = req.url.split('/').pop() || '';
                    const decision = this.decisions.get(id) || { status: 'approved', response_notes: 'Approved by mobile mock' };
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, data: decision }));
                    return;
                }

                // Handle POST /api/v1/approvals
                if (req.method === 'POST' && req.url === '/api/v1/approvals') {
                    const id = `test-id-${Date.now()}`;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, data: { id } }));
                    return;
                }

                // Handle POST /api/v1/notify
                if (req.method === 'POST' && req.url === '/api/v1/notify') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }

                // Handle POST /api/v1/agent/heartbeat
                if (req.method === 'POST' && req.url === '/api/v1/agent/heartbeat') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }

                // Default success response
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            });
        });

        return new Promise<void>((resolve) => {
            this.server.listen(this.port, () => {
                resolve();
            });
        });
    }

    async stopMockServer() {
        if (this.server) {
            return new Promise<void>((resolve) => {
                this.server.close(() => resolve());
            });
        }
    }

    setDecision(id: string, decision: any) {
        this.decisions.set(id, decision);
    }

    resetRequests() {
        this.requests = [];
    }

    getRequests() {
        return this.requests;
    }

    async runHook(hookScript: string, input: any): Promise<HookResult> {
        const scriptPath = join(this.distDir, hookScript);
        
        return new Promise((resolve, reject) => {
            const child = spawn('node', [scriptPath], {
                env: {
                    ...process.env,
                    ORBITER_SERVER_URL: `http://localhost:${this.port}`,
                    ORBITER_API_KEY: 'test-api-key'
                }
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', data => { stdout += data; });
            child.stderr.on('data', data => { stderr += data; });

            child.stdin.write(JSON.stringify(input));
            child.stdin.end();

            child.on('close', (code) => {
                let json = null;
                try {
                    if (stdout.trim()) {
                        json = JSON.parse(stdout);
                    }
                } catch (e) {
                }

                resolve({
                    stdout,
                    stderr,
                    exitCode: code,
                    json
                });
            });

            child.on('error', reject);
        });
    }
}
