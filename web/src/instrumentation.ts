export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startWatcher } = await import('./instrumentation-node');
    startWatcher();
  }
}
