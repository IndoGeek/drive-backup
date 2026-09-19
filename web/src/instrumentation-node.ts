import { startUserWatch } from './lib/userwatch';

export function startWatcher(): void {
  try {
    startUserWatch();
  } catch (e) {
    console.error('[user-sync] could not start the account watcher:', e);
  }
}
