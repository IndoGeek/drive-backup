import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import {
  installArgs,
  installCommandText,
  installTarget,
  rebuildAndInstall,
  resolveBinaryPath,
  resolveCargo,
  type InstallRunner,
} from '@/lib/binary';
import { binaryPath, sudoTimeoutMs } from '@/lib/panel';
import { checkoutRoot } from '@/lib/env';
import path from 'node:path';
import { activeGrant, authorizePrivileged, runElevated } from '@/lib/sudo';
import { recordAudit } from '@/lib/audit';
import { clientAddress } from '@/lib/session';

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

async function run(req: Request, username: string): Promise<InstallResponse | NextResponse> {
  const root = checkoutRoot();
  const target = installTarget(root, resolveBinaryPath(binaryPath()));

  // Installing over the shared binary is privileged work, so the install step runs
  // under *this user's* sudo: silent when their rules are NOPASSWD, otherwise
  // authorized by the password they supplied (see lib/sudo.ts). The build is not
  // privileged — it only writes inside the checkout.
  const install: InstallRunner = async (t, root) => {
    // Absolute source *and* the checkout as cwd: `install` resolves a relative
    // source against the cwd, and the panel process runs in web/, not the checkout.
    const source = path.join(root, 'target', 'release', 'backup-mgr');
    const label = `sudo install -m 0755 ${source} ${t}`;
    // `installArgs` deliberately omits the command name: the program is passed
    // separately, and repeating it made install read two sources and insist the
    // target be a directory.
    const args = installArgs(source, t);
    const outcome = await runElevated(req, username, 'install', args, {
      timeoutMs: 120_000,
      cwd: root,
    });
    if (outcome.ok) {
      return { code: 0, output: outcome.stderr.trim(), step: label };
    }
    if (outcome.needs_password) return { code: 1, output: '', step: '__needs_password__' };
    return { code: 1, output: outcome.error, step: label };
  };

  const steps = await rebuildAndInstall(root, target, install);
  const needsPassword = steps.some((s) => s.step === '__needs_password__');
  if (needsPassword) {
    return NextResponse.json(
      {
        error: 'a sudo password is required to install the binary',
        sudo_required: true,
        action: 'reinstall the shared binary',
        timeout_ms: sudoTimeoutMs(),
      },
      { status: 428 },
    );
  }

  const ok = steps.length > 0 && steps.every((s) => s.ok);
  const failedInstall = steps.find((s) => !s.ok && s.step.startsWith('sudo'));
  return {
    ok,
    target,
    steps,
    install_command: installCommandText(target),
    hint: !ok
      ? failedInstall
        ? 'The install step could not write the binary. Make sure your account may run sudo, or run the command below yourself.'
        : `Rebuild failed — check that cargo is available to the panel process (looked for ${resolveCargo()}).`
      : 'Installed. The daemon keeps running the old binary until you restart it.',
  };
}

export async function POST(req: Request) {
  // Panel-scoped, not instance-scoped: one shared binary serves every user, so
  // this is gated by the privileged `binary.install` permission rather than by
  // which instance the caller owns.
  const g = guard(req, 'binary.install');
  if (!g.ok) return g.response;

  // ...and then by the caller's own sudo, so the panel cannot lend anyone a
  // privilege their Linux account does not have.
  const denial = await authorizePrivileged(req, g.user, 'reinstall the shared binary');
  if (denial) return denial;

  if (inFlight) {
    return NextResponse.json({ error: 'a rebuild is already running' }, { status: 409 });
  }
  inFlight = true;
  try {
    const result = await run(req, g.user.username);
    if (result instanceof NextResponse) return result;
    recordAudit({
      username: g.user.username,
      action: 'reinstall the shared binary',
      outcome: result.ok ? 'allowed' : 'failed',
      via: activeGrant(req, g.user.username) ? 'password' : 'passwordless',
      detail: { target: result.target, steps: result.steps.map((s) => s.step) },
      error: result.ok ? null : (result.steps.find((s) => !s.ok)?.output ?? null),
      address: clientAddress(req),
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } finally {
    inFlight = false;
  }
}
