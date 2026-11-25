import { describe, expect, it } from 'vitest';

describe('bridge runtime config', () => {
  it('defaults live hooks to the production Orbiter backend', async () => {
    const previous = process.env.ORBITER_SERVER_URL;
    delete process.env.ORBITER_SERVER_URL;

    const { getOrbiterServerUrl } = await import('../src/config');

    expect(getOrbiterServerUrl()).toBe('https://api.orbiterdev.ai');

    if (previous === undefined) {
      delete process.env.ORBITER_SERVER_URL;
    } else {
      process.env.ORBITER_SERVER_URL = previous;
    }
  });

  it('uses ORBITER_SERVER_URL when explicitly configured', async () => {
    const previous = process.env.ORBITER_SERVER_URL;
    process.env.ORBITER_SERVER_URL = 'https://example.invalid';

    const { getOrbiterServerUrl } = await import('../src/config');

    expect(getOrbiterServerUrl()).toBe('https://example.invalid');

    if (previous === undefined) {
      delete process.env.ORBITER_SERVER_URL;
    } else {
      process.env.ORBITER_SERVER_URL = previous;
    }
  });

  it('defaults live approval waits to 120 seconds', async () => {
    const previousClaude = process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS;
    const previousGeneric = process.env.ORBITER_APPROVAL_TIMEOUT_SECONDS;
    delete process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS;
    delete process.env.ORBITER_APPROVAL_TIMEOUT_SECONDS;

    const { getOrbiterApprovalTimeoutSeconds } = await import('../src/config');

    expect(getOrbiterApprovalTimeoutSeconds()).toBe(120);

    if (previousClaude === undefined) {
      delete process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS;
    } else {
      process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS = previousClaude;
    }
    if (previousGeneric === undefined) {
      delete process.env.ORBITER_APPROVAL_TIMEOUT_SECONDS;
    } else {
      process.env.ORBITER_APPROVAL_TIMEOUT_SECONDS = previousGeneric;
    }
  });

  it('uses ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS for controlled hook tests', async () => {
    const previous = process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS;
    process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS = '5';

    const { getOrbiterApprovalTimeoutSeconds } = await import('../src/config');

    expect(getOrbiterApprovalTimeoutSeconds()).toBe(5);

    if (previous === undefined) {
      delete process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS;
    } else {
      process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS = previous;
    }
  });

  it('falls back to the safe default for invalid timeout values', async () => {
    const previous = process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS;
    process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS = 'nope';

    const { getOrbiterApprovalTimeoutSeconds } = await import('../src/config');

    expect(getOrbiterApprovalTimeoutSeconds()).toBe(120);

    if (previous === undefined) {
      delete process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS;
    } else {
      process.env.ORBITER_CLAUDE_APPROVAL_TIMEOUT_SECONDS = previous;
    }
  });
});
