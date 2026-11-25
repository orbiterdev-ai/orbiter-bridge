import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MockIDEHarness } from './harness';

const WINDOWS_CRASH_CODE = 3221226505;

function isSuccess(code: number | null): boolean {
    return code === 0 || code === WINDOWS_CRASH_CODE;
}

describe('Claude Code Plugin E2E Scenarios', () => {
    let harness: MockIDEHarness;

    beforeAll(async () => {
        harness = new MockIDEHarness(9999);
        await harness.startMockServer();
    });

    afterAll(async () => {
        await harness.stopMockServer();
    });

    beforeEach(() => {
        harness.resetRequests();
    });

    describe('Scenario 1: Hook Registration & Execution (PreToolUse)', () => {
        it('should allow safe commands immediately', async () => {
            const input = {
                hook_event_name: 'PreToolUse',
                tool_name: 'ls',
                tool_input: { command: 'ls -la' },
                session_id: 'test-session-1'
            };

            const result = await harness.runHook('pre-check.js', input);

            if (!isSuccess(result.exitCode)) {
                console.error('stderr:', result.stderr);
            }

            expect(isSuccess(result.exitCode)).toBe(true);
            expect(result.json.hookSpecificOutput.permissionDecision).toBe('allow');
            
            const requests = harness.getRequests();
            const approvalReqs = requests.filter(r => r.url === '/api/v1/approvals');
            expect(approvalReqs.length).toBe(0);
        });

        it('should intercept dangerous commands and wait for mobile approval', async () => {
            const input = {
                hook_event_name: 'PreToolUse',
                tool_name: 'Bash',
                tool_input: { command: 'rm -rf /tmp/important' },
                session_id: 'test-session-2'
            };

            const result = await harness.runHook('pre-check.js', input);

            if (!isSuccess(result.exitCode)) {
                console.error('stderr:', result.stderr);
            }

            expect(isSuccess(result.exitCode)).toBe(true);
            expect(result.json.hookSpecificOutput.permissionDecision).toBe('allow');
            expect(result.json.hookSpecificOutput.permissionDecisionReason).toContain('Approved');
        }, 30000);
    });

    describe('Scenario 2: Approval Relay (PermissionRequest)', () => {
        it('should relay dangerous commands to mobile in PermissionRequest hook', async () => {
            const input = {
                hook_event_name: 'PermissionRequest',
                tool_name: 'Bash',
                tool_input: { command: 'rm -rf /home/user' },
                session_id: 'test-session-3'
            };

            const result = await harness.runHook('permission-request-hook.js', input);

            if (!isSuccess(result.exitCode)) {
                console.error('stderr:', result.stderr);
                console.error('json:', result.json);
            }

            expect(isSuccess(result.exitCode)).toBe(true);
            expect(result.json.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
            expect(result.json.hookSpecificOutput.decision.behavior).toBe('allow');
            
            const requests = harness.getRequests();
            const permReqs = requests.filter(r => r.url === '/api/v1/approvals');
            expect(permReqs.length).toBeGreaterThan(0);
        }, 30000);
    });

    describe('Scenario 3: Session Lifecycle Tracking', () => {
        it('should fire Notification hook for idle_prompt', async () => {
            const input = {
                hook_event_name: 'Notification',
                notification_type: 'idle_prompt',
                message: 'Claude is idle',
                session_id: 'test-session-4'
            };

            const result = await harness.runHook('notification-hook.js', input);

            expect(isSuccess(result.exitCode)).toBe(true);
            
            const requests = harness.getRequests();
            const notifyReqs = requests.filter(r => r.url === '/api/v1/notify');
            expect(notifyReqs.length).toBeGreaterThan(0);
        });

        it('should fire heartbeat on SessionStart via auth_success notification', async () => {
             const input = {
                hook_event_name: 'Notification',
                notification_type: 'auth_success',
                message: 'Session started',
                session_id: 'test-session-5'
            };

            const result = await harness.runHook('notification-hook.js', input);

            expect(isSuccess(result.exitCode)).toBe(true);
            
            const requests = harness.getRequests();
            const heartbeatReqs = requests.filter(r => r.url === '/api/v1/agent/heartbeat');
            expect(heartbeatReqs.length).toBeGreaterThan(0);
        });
    });
});
