import { NextResponse } from 'next/server';
import { binarySupportsJson, parseTrailingJson, runCli, staleBinaryHint } from '@/lib/cli';
import { guard } from '@/lib/auth';
import { pickInstance, requireProvisioned } from '@/lib/routeutil';
import { encryptionState, restoreUnlockUntil } from '@/lib/restoregate';

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

  const encryption = await encryptionState(inst);
  const unlockedUntil = restoreUnlockUntil(req, g.user.username, inst.root);

  if (!(await binarySupportsJson(inst))) {
    return NextResponse.json(
      { error: `could not list backups — ${staleBinaryHint()}`, encryption, unlocked_until: unlockedUntil },
      { status: 502 },
    );
  }

  const res = await runCli(inst, ['restore', '--json'], 60_000);
  const parsed = parseTrailingJson<BackupEntry[]>(res.stdout);
  if (!parsed) {
    return NextResponse.json(
      {
        error: `could not list backups for '${inst.osUser}' — ${staleBinaryHint()}`,
        stderr: res.stderr,
        stdout: res.stdout,
        encryption,
        unlocked_until: unlockedUntil,
      },
      { status: 502 },
    );
  }
  return NextResponse.json({
    backups: parsed,
    encryption,
    unlocked_until: unlockedUntil,
  });
}
