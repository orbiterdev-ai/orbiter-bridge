import { describe, it, expect } from 'vitest';
import { HookInputSchema, EXIT_CODES, emitPreToolDecision, emitPermissionDecision } from '../src/types.js';
import type { PreToolUseOutput, PermissionRequestOutput } from '../src/types.js';

describe('HookInputSchema', () => {
    it('should parse valid tool invocation', () => {
        const input = {
            tool_name: 'run_command',
            tool_input: { command: 'ls -la' },
        };
        const parsed = HookInputSchema.parse(input);
        expect(parsed.tool_name).toBe('run_command');
        expect(parsed.tool_input.command).toBe('ls -la');
    });

    it('should parse with missing tool_input', () => {
        const input = { tool_name: 'list_files' };
        const parsed = HookInputSchema.parse(input);
        expect(parsed.tool_name).toBe('list_files');
        expect(parsed.tool_input).toEqual({});
    });

    it('should parse with tool_result', () => {
        const input = {
            tool_name: 'run_command',
            tool_input: { command: 'echo hello' },
            tool_result: 'hello\n',
        };
        const parsed = HookInputSchema.parse(input);
        expect(parsed.tool_result).toBe('hello\n');
    });

    it('should reject missing tool_name', () => {
        const input = { tool_input: { command: 'ls' } };
        expect(() => HookInputSchema.parse(input)).toThrow();
    });

    it('should handle complex tool_input', () => {
        const input = {
            tool_name: 'write_to_file',
            tool_input: {
                path: '/tmp/test.ts',
                content: 'console.log("hello")',
                overwrite: true,
            },
        };
        const parsed = HookInputSchema.parse(input);
        expect(parsed.tool_input.path).toBe('/tmp/test.ts');
        expect(parsed.tool_input.overwrite).toBe(true);
    });
});

describe('EXIT_CODES', () => {
    it('should have ALLOW as 0', () => {
        expect(EXIT_CODES.ALLOW).toBe(0);
    });

    it('should have BLOCK as 2', () => {
        expect(EXIT_CODES.BLOCK).toBe(2);
    });
});

describe('JSON Output - PreToolUse decisions', () => {
    it('should produce allow JSON with correct structure', () => {
        // Capture stdout
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPreToolDecision('allow', 'Safe command: ls');

        process.stdout.write = originalWrite;

        const parsed: PreToolUseOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('Safe command: ls');
    });

    it('should produce deny JSON with reason', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPreToolDecision('deny', 'Blocked by Orbiter Dev: npm publish not allowed');

        process.stdout.write = originalWrite;

        const parsed: PreToolUseOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('npm publish');
    });

    it('should produce ask JSON for errors/fallback', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPreToolDecision('ask', 'Orbiter could not determine - asking user');

        process.stdout.write = originalWrite;

        const parsed: PreToolUseOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    });
});

describe('JSON Output - PermissionRequest decisions', () => {
    it('should produce allow decision', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPermissionDecision('allow');

        process.stdout.write = originalWrite;

        const parsed: PermissionRequestOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
        expect(parsed.hookSpecificOutput.decision.behavior).toBe('allow');
        expect(parsed.hookSpecificOutput.decision.message).toBeUndefined();
    });

    it('should produce deny decision with message', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPermissionDecision('deny', 'Blocked by Orbiter Dev');

        process.stdout.write = originalWrite;

        const parsed: PermissionRequestOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.decision.behavior).toBe('deny');
        expect(parsed.hookSpecificOutput.decision.message).toBe('Blocked by Orbiter Dev');
    });
});

describe('JSON Output - Decision Scenarios', () => {
    it('safe command → allow decision', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        // Simulate: safe command detected
        emitPreToolDecision('allow', 'Safe command: Bash');

        process.stdout.write = originalWrite;

        const parsed: PreToolUseOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
    });

    it('deny match + approved → allow with reason', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPreToolDecision('allow', 'Approved via Orbiter Dev mobile');

        process.stdout.write = originalWrite;

        const parsed: PreToolUseOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('Approved');
    });

    it('deny match + rejected → deny with reason', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPreToolDecision('deny', 'Rejected via Orbiter Dev mobile');

        process.stdout.write = originalWrite;

        const parsed: PreToolUseOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    });

    it('403 policy block → deny with policy reason', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPreToolDecision('deny', 'Blocked by server policy: Action blocked by policy');

        process.stdout.write = originalWrite;

        const parsed: PreToolUseOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('policy');
    });

    it('crash/error → ask fallback', () => {
        let captured = '';
        const originalWrite = process.stdout.write;
        process.stdout.write = ((data: string) => {
            captured += data;
            return true;
        }) as typeof process.stdout.write;

        emitPreToolDecision('ask', 'Orbiter hook crashed - asking user');

        process.stdout.write = originalWrite;

        const parsed: PreToolUseOutput = JSON.parse(captured);
        expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    });
});
