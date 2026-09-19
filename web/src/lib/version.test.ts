import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareBuild, expectedVersion } from './version';

describe('expectedVersion', () => {
  it('reads the package version out of Cargo.toml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-cargo-'));
    const file = path.join(dir, 'Cargo.toml');
    fs.writeFileSync(file, '[package]\nname = "backup-mgr"\nversion = "1.2.3"\nedition = "2021"\n');
    expect(expectedVersion(file)).toBe('1.2.3');
  });

  it('is not fooled by a dependency version line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-cargo-'));
    const file = path.join(dir, 'Cargo.toml');
    fs.writeFileSync(
      file,
      '[package]\nname = "backup-mgr"\nversion = "9.9.9"\n\n[dependencies]\nserde = { version = "1" }\n',
    );
    expect(expectedVersion(file)).toBe('9.9.9');
  });

  it('returns null when Cargo.toml is unreadable', () => {
    expect(expectedVersion('/definitely/not/here/Cargo.toml')).toBeNull();
  });
});

describe('compareBuild', () => {
  const expected = { version: '1.0.0', commit: 'abc1234' };

  it('accepts a binary built from the served checkout', () => {
    const r = compareBuild({ version: '1.0.0', commit: 'abc1234' }, expected);
    expect(r.stale).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('flags a binary that cannot report a version at all', () => {
    const r = compareBuild(null, expected);
    expect(r.stale).toBe(true);
    expect(r.reasons[0]).toMatch(/predates/);
  });

  it('flags a commit mismatch', () => {
    const r = compareBuild({ version: '1.0.0', commit: 'deadbee' }, expected);
    expect(r.stale).toBe(true);
    expect(r.reasons.join(' ')).toContain('deadbee');
  });

  it('flags a version mismatch', () => {
    const r = compareBuild({ version: '0.9.0', commit: 'abc1234' }, expected);
    expect(r.stale).toBe(true);
    expect(r.reasons.join(' ')).toContain('0.9.0');
  });

  it('reports both mismatches at once', () => {
    const r = compareBuild({ version: '0.9.0', commit: 'deadbee' }, expected);
    expect(r.stale).toBe(true);
    expect(r.reasons).toHaveLength(2);
  });

  it('ignores an unknown commit rather than guessing', () => {
    const r = compareBuild({ version: '1.0.0', commit: 'unknown' }, expected);
    expect(r.stale).toBe(false);
  });

  it('skips fields the checkout cannot supply', () => {
    const r = compareBuild({ version: '1.0.0', commit: 'abc1234' }, { version: null, commit: null });
    expect(r.stale).toBe(false);
  });
});
