import { z } from 'zod';

/**
 * Claude Code Hook Input Schema (v2.1+ compliant)
 * 
 * Claude Code pipes this JSON to stdin when invoking hooks.
 * Updated to include common input fields per latest Anthropic docs:
 * session_id, transcript_path, cwd, permission_mode, hook_event_name
 */

// ─── Common Fields (shared across ALL hook events) ───

export const CommonHookFields = {
    session_id: z.string().optional(),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    permission_mode: z.enum(['default', 'auto', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions']).optional(),
    hook_event_name: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
};

// ─── Tool Hook Inputs (PreToolUse / PostToolUse) ───

export const HookInputSchema = z.object({
    ...CommonHookFields,
    // Tool-specific fields (PreToolUse / PostToolUse)
    tool_name: z.string(),
    tool_input: z.record(z.unknown()).optional().default({}),
    tool_result: z.unknown().optional(),
    tool_response: z.unknown().optional(),
});

export type HookInput = z.infer<typeof HookInputSchema>;

// ─── Notification Hook Input ───

export const NotificationInputSchema = z.object({
    ...CommonHookFields,
    message: z.string().optional(),
    title: z.string().optional(),
    notification_type: z.string().optional(),
});

export type NotificationInput = z.infer<typeof NotificationInputSchema>;

// ─── PermissionRequest Hook Input ───

export const PermissionRequestInputSchema = z.object({
    ...CommonHookFields,
    tool_name: z.string(),
    tool_input: z.record(z.unknown()).optional().default({}),
    permission_suggestions: z.array(z.object({
        type: z.string().optional(),
        description: z.string().optional(),
    })).optional(),
});

export type PermissionRequestInput = z.infer<typeof PermissionRequestInputSchema>;

// ─── TaskCompleted Hook Input ───

export const TaskCompletedInputSchema = z.object({
    ...CommonHookFields,
    task_summary: z.string().optional(),
    duration_ms: z.number().optional(),
    files_modified: z.array(z.string()).optional(),
    status: z.string().optional(),
});

export type TaskCompletedInput = z.infer<typeof TaskCompletedInputSchema>;

// ─── Session Hook Input (SessionStart / SessionEnd) ───

export const SessionInputSchema = z.object({
    ...CommonHookFields,
    /** SessionStart: 'startup' | 'resume' | 'clear' | 'compact' (Claude Code docs). */
    source: z.string().optional(),
    /** SessionEnd: 'clear' | 'logout' | 'prompt_input_exit' | 'other' (Claude Code docs). */
    reason: z.string().optional(),
});

export type SessionInput = z.infer<typeof SessionInputSchema>;

// ─── Deny Patterns ───

/**
 * Deny Pattern - a single pattern in the deny list
 */
export const DenyPatternSchema = z.object({
    pattern: z.string(),
    category: z.string(),
    description: z.string(),
    severity: z.enum(['warning', 'high', 'critical']).default('critical'),
});

export type DenyPattern = z.infer<typeof DenyPatternSchema>;

/**
 * Deny List Config - the full deny-patterns.json shape
 */
export const DenyListConfigSchema = z.object({
    version: z.string().default('1.0'),
    patterns: z.array(DenyPatternSchema),
});

export type DenyListConfig = z.infer<typeof DenyListConfigSchema>;

/**
 * The result of matching a tool invocation against the deny list
 */
export interface DenyMatch {
    matched: boolean;
    pattern: DenyPattern | null;
    matchedText: string;
}

/**
 * Exit codes for Claude Code hooks
 */
export const EXIT_CODES = {
    ALLOW: 0,          // Tool execution proceeds
    BLOCK: 2,          // Tool execution is blocked
} as const;

// ─── Claude Code v2.1+ JSON Hook Output Types ───

/**
 * Permission decisions that bypass/control Claude Code's native prompt.
 * - "allow" = skip native prompt, execute immediately
 * - "deny"  = block tool, skip native prompt
 * - "ask"   = fall back to native prompt (Claude asks the user)
 */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * Universal JSON output fields (work across ALL hook events).
 * These can be combined with hookSpecificOutput.
 */
export interface UniversalHookOutput {
    /** Set to false to stop Claude's execution loop */
    continue?: boolean;
    /** Reason shown to user when continue=false */
    stopReason?: string;
    /** If true, suppress hook output from being shown */
    suppressOutput?: boolean;
    /** Inject a system message into Claude's context */
    systemMessage?: string;
}

/**
 * Top-level decision control (works for many events)
 * Use "block" to prevent the action with a reason.
 */
export interface DecisionOutput extends UniversalHookOutput {
    decision?: 'block';
    reason?: string;
}

/**
 * JSON output for PreToolUse hooks.
 * Written to stdout - Claude Code reads this to decide tool execution.
 */
export interface PreToolUseOutput extends UniversalHookOutput {
    hookSpecificOutput: {
        hookEventName: 'PreToolUse';
        permissionDecision: PermissionDecision;
        permissionDecisionReason: string;
    };
}

/**
 * JSON output for PermissionRequest hooks.
 * Written to stdout - overrides Claude's native permission dialog.
 * Now supports updatedInput to modify tool input before execution.
 */
export interface PermissionRequestOutput extends UniversalHookOutput {
    hookSpecificOutput: {
        hookEventName: 'PermissionRequest';
        decision: {
            behavior: 'allow' | 'deny';
            message?: string;
            /** Modify the tool input before execution (e.g., sanitize command) */
            updatedInput?: Record<string, unknown>;
        };
    };
}

/**
 * JSON output for UserPromptSubmit hooks.
 * Can modify or block user prompts before they reach Claude.
 */
export interface UserPromptSubmitOutput extends UniversalHookOutput {
    hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit';
        action: 'block' | 'modify';
        content?: string;
    };
}

/**
 * JSON output for Stop hooks.
 * Controls whether Claude actually stops or continues working.
 */
export interface StopOutput extends UniversalHookOutput {
    hookSpecificOutput: {
        hookEventName: 'Stop';
        action: 'block' | 'modify';
        content?: string;
    };
}

// ─── Emit Helpers ───

/**
 * Build a PreToolUse JSON decision and write to stdout.
 */
export function emitPreToolDecision(
    decision: PermissionDecision,
    reason: string
): void {
    const output: PreToolUseOutput = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: reason,
        },
    };
    process.stdout.write(JSON.stringify(output));
}

/**
 * Build a PermissionRequest JSON decision and write to stdout.
 */
export function emitPermissionDecision(
    behavior: 'allow' | 'deny',
    message?: string,
    updatedInput?: Record<string, unknown>
): void {
    const output: PermissionRequestOutput = {
        hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
                behavior,
                ...(message ? { message } : {}),
                ...(updatedInput ? { updatedInput } : {}),
            },
        },
    };
    process.stdout.write(JSON.stringify(output));
}

/**
 * Build a decision block output and write to stdout.
 * Works for PostToolUse, Stop, SubagentStop, ConfigChange events.
 */
export function emitDecisionBlock(reason: string): void {
    const output: DecisionOutput = {
        decision: 'block',
        reason,
    };
    process.stdout.write(JSON.stringify(output));
}

/**
 * Build a continue=false output to stop Claude's execution.
 */
export function emitStop(stopReason: string): void {
    const output: UniversalHookOutput = {
        continue: false,
        stopReason,
    };
    process.stdout.write(JSON.stringify(output));
}

// ─── Shared Hook Utilities ───

/**
 * Read all of stdin as a string.
 * Shared across all hook handlers - import instead of duplicating.
 */
export function readStdin(): Promise<string> {
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

/**
 * Cleanly exit process - destroy stdin handles first to avoid
 * UV_HANDLE_CLOSING assertion crash on Windows.
 */
export function cleanExit(): never {
    try { process.stdin.destroy(); } catch { /* ignore */ }
    process.exit(0);
}

/**
 * Create a prefixed logger that writes to stderr.
 * Claude Code reads stdout for JSON decisions, ignores stderr.
 */
export function createLogger(prefix: string): (message: string) => void {
    return (message: string) => {
        process.stderr.write(`[orbiter:${prefix}] ${message}\n`);
    };
}

