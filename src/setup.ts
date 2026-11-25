#!/usr/bin/env node

/**
 * Orbiter Dev - Hook Setup CLI (v2 - Claude Code v2.1+ format)
 * 
 * Generates the Claude Code hooks configuration file:
 *   .claude/settings.local.json
 * 
 * Uses the new matcher-based format with PreToolUse, PermissionRequest,
 * and PostToolUse hooks.
 * 
 * Usage:
 *   npx @orbiterdev/mcp-server setup-hooks
 *   node dist/setup.js
 */

import * as fs from 'fs';
import * as path from 'path';

interface ToolHook {
    type: 'command';
    command: string;
}

interface HookMatcher {
    matcher: string;
    hooks: ToolHook[];
}

interface ClaudeSettings {
    hooks?: {
        PreToolUse?: HookMatcher[];
        PermissionRequest?: HookMatcher[];
        PostToolUse?: HookMatcher[];
        Notification?: HookMatcher[];
        TaskCompleted?: HookMatcher[];
        SessionStart?: HookMatcher[];
        SessionEnd?: HookMatcher[];
    };
    [key: string]: unknown;
}

async function main(): Promise<void> {
    console.log('🛸 Orbiter Dev - Hook Setup (v3 - Claude hook pack)\n');

    // 1. Check ORBITER_TOKEN
    const token = process.env.ORBITER_TOKEN;
    if (!token) {
        console.log('⚠️  ORBITER_TOKEN environment variable is not set.');
        console.log('   Set it in your shell profile or .env file:');
        console.log('   export ORBITER_TOKEN=your_token_here\n');
        console.log('   You can still set up hooks now - they will use the');
        console.log('   token from the environment when Claude Code runs.\n');
    } else {
        console.log('✅ ORBITER_TOKEN detected\n');
    }

    // 2. Resolve script paths
    const bridgeDir = path.resolve(__dirname, '..');
    const distDir = path.join(bridgeDir, 'dist');
    const preCheckPath = path.join(distDir, 'pre-check.js');
    const permissionHandlerPath = path.join(distDir, 'permission-handler.js');
    const postHookPath = path.join(distDir, 'post-hook.js');
    const notificationHookPath = path.join(distDir, 'notification-hook.js');
    const permissionRequestHookPath = path.join(distDir, 'permission-request-hook.js');
    const taskCompletedHookPath = path.join(distDir, 'task-completed-hook.js');
    const sessionHooksPath = path.join(distDir, 'session-hooks.js');

    // Check if scripts are built
    if (!fs.existsSync(preCheckPath)) {
        console.log('⚠️  Hook scripts not built yet.');
        console.log(`   Run: cd ${bridgeDir} && npm run build\n`);
        console.log('   Setting up config with expected paths anyway...\n');
    }

    // 3. Create .claude directory
    const cwd = process.cwd();
    const claudeDir = path.join(cwd, '.claude');
    if (!fs.existsSync(claudeDir)) {
        fs.mkdirSync(claudeDir, { recursive: true });
        console.log(`📁 Created ${claudeDir}`);
    }

    // 4. Read or create settings file
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    let settings: ClaudeSettings = {};

    if (fs.existsSync(settingsPath)) {
        try {
            const content = fs.readFileSync(settingsPath, 'utf-8');
            settings = JSON.parse(content);
            console.log(`📄 Found existing ${settingsPath}`);
        } catch {
            console.log('⚠️  Could not parse existing settings, creating fresh');
            settings = {};
        }
    }

    // 5. Normalize paths (forward slashes for JSON)
    const norm = (p: string) => p.replace(/\\/g, '/');

    // 6. Configure ALL hooks (v3 - full coverage)
    settings.hooks = {
        // ── Existing hooks (upgraded) ──
        PreToolUse: [
            {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: `node "${norm(preCheckPath)}"` }],
            },
        ],
        PermissionRequest: [
            {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: `node "${norm(permissionRequestHookPath)}"` }],
            },
        ],
        PostToolUse: [
            {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: `node "${norm(postHookPath)}"` }],
            },
        ],
        // ── NEW: Notification hooks (4 matchers) ──
        Notification: [
            {
                matcher: 'permission_prompt',
                hooks: [{ type: 'command', command: `node "${norm(notificationHookPath)}"` }],
            },
            {
                matcher: 'idle_prompt',
                hooks: [{ type: 'command', command: `node "${norm(notificationHookPath)}"` }],
            },
            {
                matcher: 'auth_success',
                hooks: [{ type: 'command', command: `node "${norm(notificationHookPath)}"` }],
            },
            {
                matcher: 'elicitation_dialog',
                hooks: [{ type: 'command', command: `node "${norm(notificationHookPath)}"` }],
            },
        ],
        // ── NEW: Task lifecycle ──
        TaskCompleted: [
            {
                matcher: '',
                hooks: [{ type: 'command', command: `node "${norm(taskCompletedHookPath)}"` }],
            },
        ],
        // ── NEW: Session lifecycle ──
        SessionStart: [
            {
                matcher: '',
                hooks: [{ type: 'command', command: `node "${norm(sessionHooksPath)}"` }],
            },
        ],
        SessionEnd: [
            {
                matcher: '',
                hooks: [{ type: 'command', command: `node "${norm(sessionHooksPath)}"` }],
            },
        ],
    };

    // 7. Write settings
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    console.log(`\n✅ Hooks configured in ${settingsPath}\n`);
    console.log('Registered hooks (7 events):');
    console.log(`  PreToolUse:        node "${norm(preCheckPath)}"`);
    console.log(`  PermissionRequest: node "${norm(permissionRequestHookPath)}"`);
    console.log(`  PostToolUse:       node "${norm(postHookPath)}"`);
    console.log(`  Notification:      node "${norm(notificationHookPath)}" (4 matchers)`);
    console.log(`  TaskCompleted:     node "${norm(taskCompletedHookPath)}"`);
    console.log(`  SessionStart:      node "${norm(sessionHooksPath)}"`);
    console.log(`  SessionEnd:        node "${norm(sessionHooksPath)}"`);
    console.log('\nHooks will be active next time Claude Code starts in this directory.');

    // 8. Show env reminder
    console.log('\n📋 Required environment variables:');
    console.log('  ORBITER_TOKEN        - Your Orbiter Dev auth token');
    console.log('  ORBITER_SERVER_URL   - Backend URL (default: https://api.orbiterdev.ai)');
    console.log('\n🚀 Setup complete!\n');
}

main().catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
});
