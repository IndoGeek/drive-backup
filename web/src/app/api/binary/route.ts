import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { installCommandText, installTarget, resolveBinaryPath } from '@/lib/binary';
import { parseTrailingJson, runCli } from '@/lib/cli';
import { binary, projectRoot } from '@/lib/env';
import {
  cargoTomlPath,
  compareBuild,
  expectedVersion,
  type BuildInfo,
} from '@/lib/version';

export const runtime = 'nodejs';

export type BinaryPayload = {
  /** Configured command name (BACKUP_MGR_BIN, or the default `backup-mgr`). */
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
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;

  const root = projectRoot();
  const bin = binary();

  // `version --json` exits before config loading, so this is safe and cheap.
  const res = await runCli(['version', '--json'], 15_000);
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
