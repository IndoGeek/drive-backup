import { describe, expect, it } from 'vitest';
import { computeStale } from './stale';

const healthyState = { status: 'ok', requires_manual_resume: false };
const noLock = { present: false, age_seconds: null, pid: null, pid_alive: null };

describe('computeStale', () => {
  it('returns null when everything is healthy', () => {
    expect(computeStale(healthyState, noLock)).toBeNull();
  });

  it('returns null while a real backup is running (lock + live pid)', () => {
    const stale = computeStale(
      { status: 'running', requires_manual_resume: false },
      { present: true, age_seconds: 5, pid: 1234, pid_alive: true },
    );
    expect(stale).toBeNull();
  });

  it('flags a leftover lock while state is idle and the lock is old', () => {
    const stale = computeStale(
      healthyState,
      { present: true, age_seconds: 60 * 20, pid: 9999, pid_alive: false },
    );
    expect(stale).not.toBeNull();
    expect(stale?.items.join(' ')).toContain('run lock');
  });

  it('does not flag a lock that is seconds old while transitioning (finishing window)', () => {
    expect(
      computeStale(
        healthyState,
        { present: true, age_seconds: 2, pid: null, pid_alive: null },
      ),
    ).toBeNull();
  });

  it('flags a frozen running state whose process is dead', () => {
    const stale = computeStale(
      { status: 'running', requires_manual_resume: false },
      { present: true, age_seconds: 500, pid: 4311, pid_alive: false },
    );
    expect(stale?.items.join(' ')).toContain('no longer alive');
  });

  it('does not flag a running state whose pid file is missing (startup window)', () => {
    expect(
      computeStale(
        { status: 'running', requires_manual_resume: false },
        { present: true, age_seconds: 1, pid: null, pid_alive: null },
      ),
    ).toBeNull();
  });

  it('flags requires_manual_resume regardless of the lock', () => {
    const stale = computeStale(
      { status: 'failed', requires_manual_resume: true },
      noLock,
    );
    expect(stale?.items.join(' ')).toContain('waiting for a reset');
  });
});