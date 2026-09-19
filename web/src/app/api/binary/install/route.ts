import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import {
  installCommandText,
  installTarget,
  rebuildAndInstall,
  resolveBinaryPath,
  resolveCargo,
} from '@/lib/binary';
import { binary, projectRoot } from '@/lib/env';

export const runtime = 'nodejs';
// `cargo build --release` can take minutes on a small VPS.
export const maxDuration = 1200;

/** Only one rebuild at a time; a second click must not race the first. */
let inFlight = false;

export type InstallResponse = {
  ok: boolean;
  target: string;
  steps: { step: string; ok: boolean; code: number | null; output: string }[];
  install_command: string;
  hint: string;
};

async function run(): Promise<InstallResponse> {
  const root = projectRoot();
  const target = installTarget(root, resolveBinaryPath(binary()));
  const steps = await rebuildAndInstall(root, target);
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  const failedInstall = steps.find((s) => !s.ok && s.step.startsWith('sudo'));
  return {
    ok,
    target,
    steps,
    install_command: installCommandText(target),
    hint: !ok
      ? failedInstall
        ? 'The install step could not write the binary. Grant passwordless sudo for it, e.g. a sudoers rule for `install -m 0755 target/release/backup-mgr ' +
          target +
          '`, or run the command below yourself.'
        : `Rebuild failed — check that cargo is available to the panel process (looked for ${resolveCargo()}).`
      : 'Installed. The daemon keeps running the old binary until you restart it.',
  };
}

export async function POST(req: Request) {
  const g = guard(req, 'binary.install');
  if (!g.ok) return g.response;

  if (inFlight) {
    return NextResponse.json({ error: 'a rebuild is already running' }, { status: 409 });
  }
  inFlight = true;
  try {
    const body = await run();
    return NextResponse.json(body, { status: body.ok ? 200 : 502 });
  } finally {
    inFlight = false;
  }
}
