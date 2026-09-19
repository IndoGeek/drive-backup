import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  process.env.BACKUP_MGR_SESSION_SECRET = 'test-secret';
});

async function sessionApi() {
  return import('./session');
}

describe('session cookies', () => {
  it('round-trips a signed session', async () => {
    const { createSession, parseSession } = await sessionApi();
    const { value } = createSession(7);
    expect(parseSession(value)?.userId).toBe(7);
  });

  it('rejects a tampered signature', async () => {
    const { createSession, parseSession } = await sessionApi();
    const { value } = createSession(7);
    const parts = value.split('.');
    const forged = `${parts[0]}.${parts[1]}.${'0'.repeat(parts[2].length)}`;
    expect(parseSession(forged)).toBeNull();
  });

  it('rejects a tampered user id', async () => {
    const { createSession, parseSession } = await sessionApi();
    const { value } = createSession(7);
    const [, exp, sig] = value.split('.');
    expect(parseSession(`8.${exp}.${sig}`)).toBeNull();
  });

  it('rejects malformed and expired values', async () => {
    const { parseSession } = await sessionApi();
    expect(parseSession(undefined)).toBeNull();
    expect(parseSession('nonsense')).toBeNull();
    expect(parseSession(`1.${Date.now() - 1000}.deadbeef`)).toBeNull();
  });
});
