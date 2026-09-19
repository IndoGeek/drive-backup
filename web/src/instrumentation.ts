/**
 * Next.js runs `register()` once when the server process boots (`next start`),
 * which is the hook the panel needs to keep its mirror of Linux accounts current.
 *
 * The multi-user model is "Linux accounts are the identities", so an account added
 * with `useradd` has to appear in the panel on its own. That is what
 * ./instrumentation-node.ts — and behind it ./lib/userwatch.ts — does: an
 * immediate reconcile at startup, then a poll plus a watch on the passwd file.
 * Without it, a new account would only be picked up when someone opened the Users
 * page or signed in.
 *
 * The shape of this file matters. It is compiled for the Node *and* Edge runtimes,
 * and Edge cannot resolve `node:fs` or the native sqlite module at all, which
 * fails the whole build. The Node-only module graph is therefore kept in a
 * separate file behind the `NEXT_RUNTIME === 'nodejs'` branch below, so the Edge
 * build can eliminate it entirely. Keep the guard as a positive equality test on
 * the environment variable — and keep this file free of Node imports.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startWatcher } = await import('./instrumentation-node');
    startWatcher();
  }
}
