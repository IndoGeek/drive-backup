export type RunLockFacts = {
  present: boolean;
  age_seconds: number | null;
  pid: number | null;
  pid_alive: boolean | null;
};

export type StaleInfo = {
  message: string;
  items: string[];
};

const LEFTOVER_LOCK_MIN_AGE_SECONDS = 20;

export function computeStale(
  state: { status: string; requires_manual_resume: boolean } | null | undefined,
  lock: RunLockFacts | null | undefined,
): StaleInfo | null {
  const items: string[] = [];
  const stateStatus = (state?.status ?? '').toLowerCase();

  if (state?.requires_manual_resume === true) {
    items.push(
      'a previous backup failed mid-way and is waiting for a reset before backups can continue',
    );
  }

  if (lock?.present === true) {
    if (stateStatus === 'running') {
      if (lock.pid_alive === false) {
        items.push(
          `a run lock is present (${'.run.lock'}) but its process (pid ${
            lock.pid ?? '?'
          }) is no longer alive`,
        );
      }
    } else {
      const age = lock.age_seconds ?? null;
      if (age === null || age > LEFTOVER_LOCK_MIN_AGE_SECONDS) {
        items.push('a stale run lock (.run.lock) was left behind by an interrupted backup');
      }
    }
  }

  if (items.length === 0) return null;
  return {
    message:
      'A previous backup did not finish cleanly. Reset state to clear the stale files and allow backups to run again.',
    items,
  };
}