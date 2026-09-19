import { NextResponse } from 'next/server';
import { binarySupportsJson, parseTrailingJson, runCli, staleBinaryHint } from '@/lib/cli';
import { guard } from '@/lib/auth';

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

  // Refuse before running anything: an old binary would read `--json` as the
  // name of a backup and start a genuine restore attempt.
  if (!(await binarySupportsJson())) {
    return NextResponse.json(
      { error: `could not list backups — ${staleBinaryHint()}` },
      { status: 502 },
    );
  }

  const res = await runCli(['restore', '--json'], 60_000);
  const parsed = parseTrailingJson<BackupEntry[]>(res.stdout);
  if (!parsed) {
    // An old binary treats `--json` as a filename and tries to restore it, so
    // say plainly that the binary is the likely culprit rather than echoing a
    // confusing "backup '--json' not found".
    return NextResponse.json(
      {
        error: `could not list backups — ${staleBinaryHint()}`,
        stderr: res.stderr,
        stdout: res.stdout,
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ backups: parsed });
}
