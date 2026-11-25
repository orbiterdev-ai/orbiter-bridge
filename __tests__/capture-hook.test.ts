import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bridgeRoot = process.cwd();
const captureHookPath = path.join(bridgeRoot, 'dist', 'capture-hook.js');
const impossibleServerUrl = 'https://should-not-be-called.invalid';

function runCaptureHook(args: string[], input: unknown) {
    const result = spawnSync(process.execPath, [captureHookPath, ...args], {
        cwd: bridgeRoot,
        env: {
            ...process.env,
            ORBITER_SERVER_URL: impossibleServerUrl,
        },
        input: JSON.stringify(input),
        encoding: 'utf8',
        timeout: 15000,
    });
    if (result.error) throw result.error;
    expect(result.stdout).not.toMatch(/api\.orbiterdev\.ai/);
    expect(result.stderr).not.toMatch(/api\.orbiterdev\.ai/);
    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
}

function mkTempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readLatestReceipt(captureDir: string, event: string): Record<string, unknown> {
    const receiptDir = path.join(captureDir, 'claude-code', event);
    expect(fs.existsSync(receiptDir)).toBe(true);
    const files = fs.readdirSync(receiptDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => path.join(receiptDir, file))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    expect(files.length).toBeGreaterThan(0);
    return JSON.parse(fs.readFileSync(files[0], 'utf8'));
}

describe('Claude Code offline capture hook wrapper', () => {
    it('captures approved PreToolUse events without backend access', () => {
        const captureDir = mkTempDir('orbiter-claude-capture-');
        const output = runCaptureHook([
            'PreToolUse',
            '--capture-dir',
            captureDir,
            '--adapter',
            'mock',
            '--mock-decision',
            'approved',
        ], {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'npm publish --dry-run' },
            cwd: '/workspace/demo-app',
            session_id: 'claude-capture-session-001',
        });

        expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(output.hookSpecificOutput.permissionDecision).toBe('allow');
        const receipt = readLatestReceipt(captureDir, 'PreToolUse');
        expect(receipt.provider).toBe('claude-code');
        expect(receipt.adapter).toBe('mock');
        expect(receipt.decision_scenario).toBe('approved');
        expect(receipt.backend_used).toBe(false);
        expect(receipt.secret_scan_passed).toBe(true);
        const normalized = receipt.normalized_approval_request as Record<string, unknown>;
        expect(normalized.source_ide).toBe('claude_code');
        expect(normalized.risk_level).toBe('high');
    });

    it('captures rejected PermissionRequest events without backend access', () => {
        const captureDir = mkTempDir('orbiter-claude-permission-capture-');
        const output = runCaptureHook([
            'PermissionRequest',
            '--capture-dir',
            captureDir,
            '--adapter',
            'mock',
            '--mock-decision',
            'rejected',
        ], {
            hook_event_name: 'PermissionRequest',
            tool_name: 'Bash',
            tool_input: { command: 'git reset --hard HEAD~1' },
            cwd: '/workspace/demo-app',
            session_id: 'claude-capture-session-002',
        });

        expect(output.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
        expect(output.hookSpecificOutput.decision.behavior).toBe('deny');
        const receipt = readLatestReceipt(captureDir, 'PermissionRequest');
        expect(receipt.backend_used).toBe(false);
        expect(receipt.decision_scenario).toBe('rejected');
        expect((receipt.normalized_approval_request as Record<string, unknown>).risk_level).toBe('critical');
    });

    it('redacts credential-shaped Claude payloads and fails closed', () => {
        const captureDir = mkTempDir('orbiter-claude-secret-capture-');
        const credential = ['sk', 'capture', 'CLAUDE', '20260614', 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-');
        const output = runCaptureHook([
            'PreToolUse',
            '--capture-dir',
            captureDir,
            '--adapter',
            'mock',
            '--mock-decision',
            'approved',
        ], {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: `npm publish --otp ${credential}` },
            cwd: '/workspace/demo-app',
            session_id: 'claude-capture-session-003',
        });

        expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
        const receipt = readLatestReceipt(captureDir, 'PreToolUse');
        const receiptText = JSON.stringify(receipt);
        expect(receipt.secret_scan_passed).toBe(false);
        expect(receiptText).not.toContain(credential);
        expect(receiptText).toMatch(/\[REDACTED/);
    });
});
