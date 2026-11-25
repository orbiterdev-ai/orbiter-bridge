const DEFAULT_ORBITER_SERVER_URL = 'https://api.orbiterdev.ai';
const DEFAULT_ORBITER_APPROVAL_TIMEOUT_SECONDS = 120;

export function getOrbiterServerUrl(): string {
    return process.env.ORBITER_SERVER_URL || DEFAULT_ORBITER_SERVER_URL;
}

export function getOrbiterApprovalTimeoutSeconds(): number {
    const rawValue =
        process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS ||
        process.env.ORBITER_APPROVAL_TIMEOUT_SECONDS;

    if (!rawValue) {
        return DEFAULT_ORBITER_APPROVAL_TIMEOUT_SECONDS;
    }

    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_ORBITER_APPROVAL_TIMEOUT_SECONDS;
    }

    return Math.ceil(parsed);
}
