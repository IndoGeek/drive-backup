import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { installCommandText, installTarget, resolveBinaryPath } from '@/lib/binary';
import { parseTrailingJson, runBinary } from '@/lib/cli';
import { binaryPath } from '@/lib/panel';
import { checkoutRoot } from '@/lib/env';
import {
  cargoTomlPath,
  compareBuild,
  expectedVersion,
  type BuildInfo,
} from '@/lib/version';

export const runtime = 'nodejs';

export type BinaryPayload = {
  /**
   * The shared binary every instance runs. Installed once and read-only for
   * users; per-user isolation comes from who runs it, not from separate copies.
   */
  binary: string;
  /** Absolute path of the binary that would actually run, if resolvable. */
  resolved_path: string | null;
  file: { size: number; mtime: string } | null;
  installed: BuildInfo | null;
  expected: { version: string | null; commit: string | null };
  stale: boolean;
  reasons: string[];
  install_command: string;
};

function git(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 10_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = String(stdout).trim();
      resolve(out.length > 0 ? out : null);
    });
  });
}

/** Commit of the served checkout, matching build.rs (`-dirty` for a dirty tree). */
async function expectedCommit(root: string): Promise<string | null> {
  const sha = await git(['rev-parse', '--short', 'HEAD'], root);
  if (!sha) return null;
  const dirty = await git(['status', '--porcelain'], root);
  return dirty ? `${sha}-dirty` : sha;
}

export async function GET(req: Request) {
  // The binary is shared, so this is the same answer for everyone — and it is not
  // instance data, so it needs no per-user resolution or provisioning check.
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;

  const root = checkoutRoot();
  const bin = binaryPath();

  // Panel-level: asked of the binary directly, not through any user's instance.
  // `version --json` exits before config loading, so this is safe and cheap.
  const res = await runBinary(['version', '--json'], 15_000);
  const installed = parseTrailingJson<BuildInfo>(res.stdout);

  const expected = {
    version: expectedVersion(cargoTomlPath(root)),
    commit: await expectedCommit(root),
  };

  const comparison = compareBuild(installed, expected);

  const resolvedPath = resolveBinaryPath(bin);
  let file: BinaryPayload['file'] = null;
  if (resolvedPath) {
    try {
      const st = statSync(resolvedPath);
      file = { size: st.size, mtime: st.mtime.toISOString() };
    } catch {
      file = null;
    }
  }

  const payload: BinaryPayload = {
    binary: bin,
    resolved_path: resolvedPath,
    file,
    installed: comparison.installed,
    expected: comparison.expected,
    stale: comparison.stale,
    reasons: comparison.reasons,
    install_command: installCommandText(installTarget(root, resolvedPath)),
  };
  return NextResponse.json(payload);
}
