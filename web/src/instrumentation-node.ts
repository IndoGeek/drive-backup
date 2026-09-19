/**
 * Node-only startup work for the panel, kept in its own file on purpose.
 *
 * `instrumentation.ts` is compiled for **both** the Node and Edge runtimes, and
 * Edge cannot resolve Node built-ins (`node:fs`) or native modules
 * (`better-sqlite3`) at all. So the Node-only module graph lives here, imported
 * from a branch that the build can eliminate for Edge — see ./instrumentation.ts.
 */

import { startUserWatch } from './lib/userwatch';

/**
 * Start the account watcher. Never throws: a failure to keep the mirror live
 * must not stop the panel from serving, and a sign-in still records the account
 * (see `ensureUser` in ./lib/users.ts), so the panel stays usable either way.
 */
export function startWatcher(): void {
  try {
    startUserWatch();
  } catch (e) {
    console.error('[user-sync] could not start the account watcher:', e);
  }
}
