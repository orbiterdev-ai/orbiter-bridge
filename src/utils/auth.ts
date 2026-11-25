import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface OrbiterCredentials {
    api_key: string;
    user_id: string;
    paired_at: string;
    backend_url: string;
}

function sanitizeCredentialProfile(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    return normalized.length > 0 ? normalized.slice(0, 48) : undefined;
}

function getCredentialPath(): string {
    const runtimeEnv = process['env'];
    const explicitPath = runtimeEnv.ORBITER_CREDENTIAL_PATH;
    if (explicitPath && explicitPath.trim().length > 0) {
        return path.resolve(explicitPath);
    }

    const homeDir = os.userInfo().homedir || runtimeEnv.USERPROFILE || runtimeEnv.HOME || '';
    const profile = sanitizeCredentialProfile(runtimeEnv.ORBITER_CREDENTIAL_PROFILE);
    if (profile) {
        return path.join(homeDir, '.orbiter', 'profiles', profile, 'credentials');
    }
    return path.join(homeDir, '.orbiter', 'credentials');
}

function loadCredentials(): OrbiterCredentials | null {
    const credPath = getCredentialPath();
    if (!fs.existsSync(credPath)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(credPath, 'utf-8');
        const creds = JSON.parse(raw);
        if (creds && creds.api_key && creds.user_id && creds.backend_url) {
            return creds as OrbiterCredentials;
        }
    } catch {
        // Ignore malformed local credentials file
    }
    return null;
}

/**
 * Get standard headers for authenticated API requests.
 * Checks ORBITER_TOKEN, ORBITER_API_KEY, then local credentials file.
 */
export function getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Orbiter-Trace-Id': generateTraceId(),
    };

    const token = process.env.ORBITER_TOKEN || process.env.ORBITER_API_KEY;
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        return headers;
    }

    const creds = loadCredentials();
    if (creds && creds.api_key) {
        headers['Authorization'] = `Bearer ${creds.api_key}`;
    }

    return headers;
}

/**
 * Get auth headers with a specific trace ID (for correlating related calls).
 */
export function getAuthHeadersWithTrace(traceId: string): Record<string, string> {
    const headers = getAuthHeaders();
    headers['X-Orbiter-Trace-Id'] = traceId;
    return headers;
}

function generateTraceId(): string {
    return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}
