import { NextResponse } from 'next/server';
import { binarySupportsJson, parseTrailingJson, runCli, staleBinaryHint } from '@/lib/cli';
import { guard } from '@/lib/auth';
import { pickInstance, requireProvisioned } from '@/lib/routeutil';

export const runtime = 'nodejs';

export type BackupEntry = {
  name: string;
  source: string;
  size: number;
  modified?: string;
};

export async function GET(req: Request) {
  const g = guard(req, 'backup.restore');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  // Refuse before running anything: an old binary would read `--json` as the
  // name of a backup and start a genuine restore attempt.
  if (!(await binarySupportsJson(inst))) {
    return NextResponse.json(
      { error: `could not list backups — ${staleBinaryHint()}` },
      { status: 502 },
    );
  }

  // Listing walks this instance's own local staging dir and its remotes, as its
  // own user — so it can only ever see its own archives.
  const res = await runCli(inst, ['restore', '--json'], 60_000);
  const parsed = parseTrailingJson<BackupEntry[]>(res.stdout);
  if (!parsed) {
    return NextResponse.json(
      {
        error: `could not list backups for '${inst.osUser}' — ${staleBinaryHint()}`,
        stderr: res.stderr,
        stdout: res.stdout,
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ backups: parsed });
}
