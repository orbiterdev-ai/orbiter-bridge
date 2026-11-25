#!/usr/bin/env node

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { matchesDenyList, riskLevelForDenyPattern } from './deny-patterns.js';
import type { DenyPattern } from './types.js';
import {
    HookInputSchema,
    PermissionRequestInputSchema,
    readStdin,
    type HookInput,
    type PermissionRequestInput,
} from './types.js';

type CaptureEventName = 'PreToolUse' | 'PermissionRequest';
type CaptureAdapter = 'mock' | 'file';
type CaptureDecision = 'approved' | 'rejected' | 'timeout';

interface CaptureOptions {
    eventName: CaptureEventName;
    captureDir: string;
    adapter: CaptureAdapter;
    mockDecision: CaptureDecision;
    decisionFile?: string;
}

interface CaptureReceipt {
    provider: 'claude-code';
    event: CaptureEventName;
    captured_at: string;
    adapter: CaptureAdapter;
    decision_scenario: CaptureDecision;
    raw_payload_redacted: unknown;
    normalized_approval_request: unknown;
    hook_output: unknown;
    stdout_returned_to_ide: string;
    backend_used: false;
    secret_scan_passed: boolean;
}

const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|bearer|auth)/i;
const CREDENTIAL_PATTERNS = [
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i,
    /\bsk-[A-Za-z0-9_-]{20,}\b/i,
    /\bghp_[A-Za-z0-9_]{20,}\b/i,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
    /\bAIza[0-9A-Za-z_-]{20,}\b/i,
    /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/i,
    /\b(?:token|secret|password|api[_-]?key|authorization|credential)=["']?[^"'\s&]{8,}/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/i,
];

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const raw = await readStdin();
    const parsed = parseJson(raw);
    const rawPayload = parsed.ok ? parsed.value : rawPayloadForParseError(raw, parsed.error);
    const secretScanPassed = scanSecrets(rawPayload);

    if (!parsed.ok || !secretScanPassed) {
        const output = failClosedOutput(options.eventName, !parsed.ok
            ? 'Invalid Claude Code hook JSON; Orbiter offline capture failed closed.'
            : 'Orbiter offline capture blocked credential-shaped hook payload.');
        await emitCapturedOutput(options, rawPayload, {}, output, secretScanPassed);
        return;
    }

    const result = handleOfflineClaudeHook(parsed.value, options);
    await emitCapturedOutput(options, parsed.value, result.normalizedApprovalRequest, result.output, true);
}

function handleOfflineClaudeHook(
    payload: unknown,
    options: CaptureOptions,
): { output: unknown; normalizedApprovalRequest: unknown } {
    if (options.eventName === 'PermissionRequest') {
        const parsed = PermissionRequestInputSchema.safeParse(payload);
        if (!parsed.success) {
            return {
                output: failClosedOutput('PermissionRequest', 'Invalid Claude Code PermissionRequest payload; offline capture failed closed.'),
                normalizedApprovalRequest: {},
            };
        }
        return handlePermissionRequest(parsed.data, options);
    }

    const parsed = HookInputSchema.safeParse(payload);
    if (!parsed.success) {
        return {
            output: failClosedOutput('PreToolUse', 'Invalid Claude Code PreToolUse payload; offline capture failed closed.'),
            normalizedApprovalRequest: {},
        };
    }
    return handlePreToolUse(parsed.data, options);
}

function handlePreToolUse(
    input: HookInput,
    options: CaptureOptions,
): { output: unknown; normalizedApprovalRequest: unknown } {
    const match = matchesDenyList(input);
    const normalizedApprovalRequest = buildApprovalRequest(input, match.matched ? match.pattern : undefined);
    if (!match.matched) {
        return {
            output: preToolOutput('allow', `Safe command: ${input.tool_name}`),
            normalizedApprovalRequest,
        };
    }

    const decision = resolveDecision(options);
    if (decision === 'approved') {
        return {
            output: preToolOutput('allow', 'Approved by Orbiter offline capture.'),
            normalizedApprovalRequest,
        };
    }
    return {
        output: preToolOutput('deny', reasonForDecision(decision, match.pattern?.description || 'risky command')),
        normalizedApprovalRequest,
    };
}

function handlePermissionRequest(
    input: PermissionRequestInput,
    options: CaptureOptions,
): { output: unknown; normalizedApprovalRequest: unknown } {
    const match = matchesDenyList({
        tool_name: input.tool_name,
        tool_input: input.tool_input,
    });
    const normalizedApprovalRequest = buildApprovalRequest(input, match.matched ? match.pattern : undefined);
    if (!match.matched) {
        return {
            output: permissionOutput('allow', `Safe: ${input.tool_name}`),
            normalizedApprovalRequest,
        };
    }

    const decision = resolveDecision(options);
    if (decision === 'approved') {
        return {
            output: permissionOutput('allow', 'Approved by Orbiter offline capture.'),
            normalizedApprovalRequest,
        };
    }
    return {
        output: permissionOutput('deny', reasonForDecision(decision, match.pattern?.description || 'risky permission request')),
        normalizedApprovalRequest,
    };
}

function buildApprovalRequest(input: HookInput | PermissionRequestInput, pattern: DenyPattern | null | undefined): Record<string, unknown> {
    const command = extractCommand(input.tool_input);
    const riskReason = pattern?.description;
    return {
        action: `claude:${input.tool_name}`,
        description: command || input.tool_name,
        diff_summary: riskReason || 'No deny pattern matched.',
        file_count: 0,
        risk_level: riskLevelForDenyPattern(pattern),
        source_ide: 'claude_code',
        source_extension_version: 'orbiter-bridge-1.1.0',
        workspace_name: input.cwd || process.cwd(),
        auto_approve: false,
        codex_session_id: input.session_id || 'unknown-session',
        codex_hook_event_name: input.hook_event_name || 'unknown',
        tool_name: input.tool_name,
        tool_input_json: JSON.stringify(redactForCapture(input.tool_input), null, 2),
    };
}

function resolveDecision(options: CaptureOptions): CaptureDecision {
    if (options.adapter === 'file') return readFileDecision(options.decisionFile) || 'timeout';
    return options.mockDecision;
}

function readFileDecision(decisionFile: string | undefined): CaptureDecision | undefined {
    if (!decisionFile || !fs.existsSync(decisionFile)) return undefined;
    const content = fs.readFileSync(decisionFile, 'utf8').trim();
    if (!content) return undefined;
    try {
        const parsed = JSON.parse(content) as unknown;
        if (isRecord(parsed) && typeof parsed.decision === 'string') return parseDecision(parsed.decision);
        if (isRecord(parsed) && typeof parsed.status === 'string') return parseDecision(parsed.status);
    } catch {
        return parseDecision(content);
    }
    return parseDecision(content);
}

function reasonForDecision(decision: CaptureDecision, subject: string): string {
    if (decision === 'rejected') return `Rejected by Orbiter offline capture: ${subject}`;
    return `Orbiter offline capture timeout; fail-closed deny: ${subject}`;
}

function preToolOutput(permissionDecision: 'allow' | 'deny', reason: string): unknown {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision,
            permissionDecisionReason: reason,
        },
    };
}

function permissionOutput(behavior: 'allow' | 'deny', message: string): unknown {
    return {
        hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
                behavior,
                message,
            },
        },
    };
}

function failClosedOutput(eventName: CaptureEventName, reason: string): unknown {
    return eventName === 'PermissionRequest'
        ? permissionOutput('deny', reason)
        : preToolOutput('deny', reason);
}

async function emitCapturedOutput(
    options: CaptureOptions,
    rawPayload: unknown,
    normalizedApprovalRequest: unknown,
    output: unknown,
    secretScanPassed: boolean,
): Promise<void> {
    const stdout = `${JSON.stringify(output)}\n`;
    writeReceipt(options, rawPayload, normalizedApprovalRequest, output, stdout, secretScanPassed);
    process.stdout.write(stdout);
}

function writeReceipt(
    options: CaptureOptions,
    rawPayload: unknown,
    normalizedApprovalRequest: unknown,
    output: unknown,
    stdout: string,
    secretScanPassed: boolean,
): void {
    const capturedAt = new Date().toISOString();
    const receiptDir = path.join(options.captureDir, 'claude-code', options.eventName);
    const receiptPath = path.join(receiptDir, `${capturedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
    const receipt: CaptureReceipt = {
        provider: 'claude-code',
        event: options.eventName,
        captured_at: capturedAt,
        adapter: options.adapter,
        decision_scenario: resolveDecision(options),
        raw_payload_redacted: redactForCapture(rawPayload),
        normalized_approval_request: redactForCapture(normalizedApprovalRequest),
        hook_output: redactForCapture(output),
        stdout_returned_to_ide: redactStringForCapture(stdout),
        backend_used: false,
        secret_scan_passed: secretScanPassed,
    };
    fs.mkdirSync(receiptDir, { recursive: true });
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

function parseArgs(args: string[]): CaptureOptions {
    let eventName: CaptureEventName = 'PreToolUse';
    let captureDir = '.tmp_hook_captures';
    let adapter: CaptureAdapter = 'mock';
    let mockDecision: CaptureDecision = 'rejected';
    let decisionFile: string | undefined;
    let index = 0;

    if (args[0] === 'PreToolUse' || args[0] === 'PermissionRequest') {
        eventName = args[0];
        index = 1;
    }

    for (let i = index; i < args.length; i++) {
        const arg = args[i];
        const next = args[i + 1];
        if (arg === '--capture-dir' && next) {
            captureDir = next;
            i++;
        } else if (arg === '--adapter' && next) {
            adapter = next === 'file' ? 'file' : 'mock';
            i++;
        } else if (arg === '--mock-decision' && next) {
            mockDecision = parseDecision(next) || mockDecision;
            i++;
        } else if ((arg === '--decision-file' || arg === '--file-decision') && next) {
            decisionFile = next;
            i++;
        }
    }

    return {
        eventName,
        captureDir,
        adapter,
        mockDecision,
        decisionFile,
    };
}

function parseDecision(value: string): CaptureDecision | undefined {
    if (value === 'approved' || value === 'allow' || value === 'allowed') return 'approved';
    if (value === 'rejected' || value === 'deny' || value === 'denied') return 'rejected';
    if (value === 'timeout' || value === 'timed_out') return 'timeout';
    return undefined;
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
    try {
        return { ok: true, value: JSON.parse(raw) as unknown };
    } catch (error) {
        return { ok: false, error };
    }
}

function rawPayloadForParseError(raw: string, error: unknown): Record<string, unknown> {
    return {
        parse_error: String(error),
        raw_preview: raw.length > 1200 ? `${raw.slice(0, 1200)}...[truncated ${raw.length - 1200} chars]` : raw,
    };
}

function scanSecrets(value: unknown): boolean {
    return !containsCredentialLikeValue(value);
}

function redactForCapture(value: unknown): unknown {
    if (typeof value === 'string') return redactStringForCapture(value);
    if (Array.isArray(value)) return value.map((item) => redactForCapture(item));
    if (isRecord(value)) {
        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            output[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED:secret-field]' : redactForCapture(item);
        }
        return output;
    }
    return value;
}

function redactStringForCapture(value: string): string {
    let output = value;
    for (const pattern of CREDENTIAL_PATTERNS) {
        output = output.replace(pattern, '[REDACTED:credential]');
    }
    output = output.replace(/\b(Authorization:\s*)[^\r\n]+/gi, '$1[REDACTED:credential]');
    output = output.replace(/\b([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1[REDACTED:user]');
    output = output.replace(/\b(\/Users\/)[^/\s"']+/g, '$1[REDACTED:user]');
    return output;
}

function containsCredentialLikeValue(value: unknown): boolean {
    if (typeof value === 'string') return stringContainsCredentialLikeValue(value);
    if (Array.isArray(value)) return value.some((item) => containsCredentialLikeValue(item));
    if (isRecord(value)) {
        return Object.entries(value).some(([key, item]) => {
            if (SECRET_KEY_PATTERN.test(key) && primitiveHasContent(item)) return true;
            return containsCredentialLikeValue(item);
        });
    }
    return false;
}

function stringContainsCredentialLikeValue(value: string): boolean {
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) return true;
    const candidates = value.match(/[A-Za-z0-9_+=/-]{40,}/g) || [];
    return candidates.some((candidate) => entropy(candidate) >= 4.6 && /[A-Za-z]/.test(candidate) && /\d/.test(candidate));
}

function primitiveHasContent(value: unknown): boolean {
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.length > 0;
    if (isRecord(value)) return Object.keys(value).length > 0;
    return false;
}

function entropy(value: string): number {
    if (!value.length) return 0;
    const counts = new Map<string, number>();
    for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
    let result = 0;
    for (const count of counts.values()) {
        const probability = count / value.length;
        result -= probability * Math.log2(probability);
    }
    return result;
}

function extractCommand(toolInput: Record<string, unknown>): string {
    if (typeof toolInput.command === 'string') return toolInput.command;
    if (typeof toolInput.CommandLine === 'string') return toolInput.CommandLine;
    if (typeof toolInput.query === 'string') return `SQL: ${toolInput.query.substring(0, 200)}`;
    return JSON.stringify(redactForCapture(toolInput)).slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

main().catch((error) => {
    process.stderr.write(`[orbiter:capture-hook] Fatal error: ${String(error)}\n`);
    const output = failClosedOutput('PreToolUse', 'Orbiter offline capture hook crashed; fail-closed deny.');
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exit(0);
});
