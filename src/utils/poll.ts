import { getAuthHeaders } from './auth';

/**
 * Poll for an approval decision.
 *
 * After submitting an approval request, this polls the backend
 * until the status changes from "pending" to "approved" or "rejected".
 */
export async function pollForDecision(
    serverUrl: string,
    approvalId: string,
    timeoutSeconds: number = 300,
    intervalMs: number = 3000
): Promise<{ status: string; notes: string; timedOut: boolean }> {
    const deadline = Date.now() + (timeoutSeconds * 1000);
    let lastError = '';

    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${serverUrl}/api/v1/approvals/${approvalId}`, {
                method: 'GET',
                headers: getAuthHeaders(),
            });

            if (!response.ok) {
                lastError = `Server responded with ${response.status}`;
                await sleep(intervalMs);
                continue;
            }

            const data: any = await response.json();
            const approval = data.data;

            if (!approval) {
                lastError = 'No approval data in response';
                await sleep(intervalMs);
                continue;
            }

            const status = approval.status?.String || approval.status;

            if (status && status !== 'pending') {
                return {
                    status,
                    notes: approval.response_notes?.String || approval.response_notes || '',
                    timedOut: false,
                };
            }

            await sleep(intervalMs);
        } catch (error: any) {
            lastError = error.message;
            await sleep(intervalMs);
        }
    }

    return {
        status: 'timeout',
        notes: `No decision received within ${timeoutSeconds}s. Last error: ${lastError}`,
        timedOut: true,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
