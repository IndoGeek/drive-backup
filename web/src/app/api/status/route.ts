import { NextResponse } from 'next/server';
import { parseTrailingJson, runCli, staleBinaryHint } from '@/lib/cli';
import { guard } from '@/lib/auth';
import { binaryPath } from '@/lib/panel';
import { instanceView, pickInstance, requireProvisioned } from '@/lib/routeutil';
import { computeStale, type RunLockFacts, type StaleInfo } from '@/lib/stale';

export const runtime = 'nodejs';

export type StatusPayload = {
  state: {
    stage: string;
    status: string;
    current_backup: string;
    started_at: string | null;
    finished_at: string | null;
    last_error: string;
    requires_manual_resume: boolean;
    last_run_at: string | null;
    generation: number;
    progress: number | null;
  };
  config: {
    backup_path: string;
    backup_dir: string;
    log_dir: string;
    compression: string;
    time: string;
    backups_per_day: number;
    timezone: string;
    encrypt_enabled: boolean;
    upload_to_all: boolean;
    max_local_backups: number;
    min_free_disk_gb: number;
  };
  remotes: { label: string; remote: string; dir: string; retention: number }[];
  next_run_at?: string | null;
  next_run_seconds?: number | null;
  run_lock?: RunLockFacts;
  stale?: StaleInfo | null;
};

export async function GET(req: Request) {
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const res = await runCli(inst, ['status', '--json'], 30_000);
  const parsed = parseTrailingJson<StatusPayload>(res.stdout);
  if (!parsed) {
    return NextResponse.json(
      {
        error: `could not read status for '${inst.osUser}' — ${staleBinaryHint()}`,
        instance: instanceView(inst),
        binary: binaryPath(),
        spawn_error: res.spawnError ?? null,
        stderr: res.stderr,
        stdout: res.stdout,
      },
      { status: 502 },
    );
  }
  const stale = computeStale(parsed.state, parsed.run_lock);
  return NextResponse.json({ ...parsed, stale, instance: instanceView(inst) });
}
