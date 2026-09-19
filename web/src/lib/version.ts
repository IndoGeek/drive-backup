import { readFileSync } from 'node:fs';
import path from 'node:path';

export type BuildInfo = {
  name?: string;
  version?: string;
  commit?: string;
  built_at?: string;
};

export type ExpectedBuild = {
  version: string | null;
  commit: string | null;
};

export type VersionComparison = {
  /** True when the installed binary does not match the checkout being served. */
  stale: boolean;
  reasons: string[];
  installed: BuildInfo | null;
  expected: ExpectedBuild;
};

/** Read `version = "x.y.z"` out of the project's Cargo.toml. */
export function expectedVersion(cargoTomlPath: string): string | null {
  try {
    const text = readFileSync(cargoTomlPath, 'utf8');
    const m = text.match(/^\s*version\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Cargo.toml within the served checkout. */
export function cargoTomlPath(projectRoot: string): string {
  return path.join(projectRoot, 'Cargo.toml');
}

const UNKNOWN = new Set(['', 'unknown', 'none']);

function known(value: string | null | undefined): value is string {
  return !!value && !UNKNOWN.has(value.trim().toLowerCase());
}

/**
 * Decide whether the installed binary is out of date relative to the checkout
 * the panel is serving. Pure so it can be unit tested without a toolchain.
 *
 * A comparison is only made on a field when both sides are known — a binary
 * built from a tarball (commit `unknown`) is not reported as stale for that.
 */
export function compareBuild(
  installed: BuildInfo | null,
  expected: ExpectedBuild,
): VersionComparison {
  const reasons: string[] = [];

  if (!installed) {
    reasons.push(
      'could not read a version from the installed binary — it predates the `version` command, so it is out of date.',
    );
    return { stale: true, reasons, installed, expected };
  }

  if (known(expected.version) && known(installed.version) && installed.version !== expected.version) {
    reasons.push(
      `binary version ${installed.version} does not match the checkout (${expected.version}).`,
    );
  }

  if (known(expected.commit) && known(installed.commit) && installed.commit !== expected.commit) {
    reasons.push(
      `binary was built from ${installed.commit} but the checkout is at ${expected.commit}.`,
    );
  }

  return { stale: reasons.length > 0, reasons, installed, expected };
}
