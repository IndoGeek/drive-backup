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
  stale: boolean;
  reasons: string[];
  installed: BuildInfo | null;
  expected: ExpectedBuild;
};

export function expectedVersion(cargoTomlPath: string): string | null {
  try {
    const text = readFileSync(cargoTomlPath, 'utf8');
    const m = text.match(/^\s*version\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function cargoTomlPath(projectRoot: string): string {
  return path.join(projectRoot, 'Cargo.toml');
}

const UNKNOWN = new Set(['', 'unknown', 'none']);

function known(value: string | null | undefined): value is string {
  return !!value && !UNKNOWN.has(value.trim().toLowerCase());
}

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
