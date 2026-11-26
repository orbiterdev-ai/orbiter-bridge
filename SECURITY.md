# Security Policy

## Supported Versions

Security updates are provided for the latest release line of `orbiter-bridge`:

| Version | Supported |
|---------|-----------|
| `1.1.x` | Yes |
| `< 1.1.0` | No |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Report suspected security issues privately by emailing **[support@orbiterdev.ai](mailto:support@orbiterdev.ai)** with the subject line `[SECURITY] orbiter-bridge: <short summary>`.

Include as much of the following as possible:

- Affected version, Node.js runtime, and operating system
- Reproduction steps or minimal sanitized hook input
- Potential impact and any suggested remediation

## Response SLA

- **Initial acknowledgment:** within 24 business hours
- **Triage and severity confirmation:** within 72 hours
- **Target remediation timelines:**
  - Critical severity: within 7 days
  - High severity: within 14 days
  - Moderate severity: within 30 days
- **Coordinated disclosure:** we coordinate public advisories and credit researchers once a fix is released (unless anonymity is requested).

## Security Architecture & Trust Boundary

`orbiter-bridge` intercepts dangerous AI agent tool calls locally before execution:

- **Out-of-band mobile biometric boundary:** matched high-risk actions pause execution and require explicit approval from the paired Orbiter Dev mobile app (iOS Face ID or Android biometrics) over TLS.
- **Fail-closed on rejection or timeout:** once an approval request is created, mobile rejection or decision timeout exits with code `2` to block execution.
- **Local credential redaction:** bearer tokens, API keys, and private key blocks are scrubbed from captured payloads and summaries before leaving the workstation.
- **Least-privilege credential loading:** tokens are read from local per-profile credential files (`~/.orbiter/`) or explicit environment variables and are never logged to stdout or stderr.

## Scope Exclusions

- Attacks where a local attacker already controls the user's shell environment, `ORBITER_TOKEN`, or `~/.orbiter/` directory
- Vulnerabilities in third-party AI agent hosts (report those to the respective vendor)
