import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareRunningBinary,
  installArgs,
  installCommandText,
  installTarget,
  resolveBinaryPath,
  resolveCargo,
} from './binary';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('installTarget', () => {
  const root = '/srv/backup';

  it('defaults to the PATH location when the binary cannot be resolved', () => {
    expect(installTarget(root, null)).toBe('/usr/local/bin/backup-mgr');
  });

  it('never suggests copying the build output onto itself', () => {
    expect(installTarget(root, '/srv/backup/target/release/backup-mgr')).toBe(
      '/usr/local/bin/backup-mgr',
    );
  });

  it('keeps a deliberately different install location', () => {
    expect(installTarget(root, '/opt/bin/backup-mgr')).toBe('/opt/bin/backup-mgr');
  });

  it('is not fooled by a sibling directory sharing the prefix', () => {
    // /srv/backup/targets is NOT inside /srv/backup/target
    expect(installTarget(root, '/srv/backup/targets/backup-mgr')).toBe(
      '/srv/backup/targets/backup-mgr',
    );
  });
});

describe('resolveCargo', () => {
  it('honours an explicit override', () => {
    expect(resolveCargo({ CARGO_BIN: '/opt/cargo/bin/cargo' })).toBe('/opt/cargo/bin/cargo');
  });

  it('finds the rustup per-user install without a shell PATH', () => {
    const home = tmpDir('bm-home-');
    const cargo = path.join(home, '.cargo', 'bin', 'cargo');
    fs.mkdirSync(path.dirname(cargo), { recursive: true });
    fs.writeFileSync(cargo, '');
    expect(resolveCargo({ HOME: home })).toBe(cargo);
  });

  it('falls back to PATH when rustup is not present', () => {
    expect(resolveCargo({ HOME: '/nonexistent-home-for-tests' })).toBe('cargo');
  });
});

describe('resolveBinaryPath', () => {
  it('resolves a bare name against PATH', () => {
    const dir = tmpDir('bm-path-');
    const bin = path.join(dir, 'bm-test-binary');
    fs.writeFileSync(bin, '');
    const old = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(resolveBinaryPath('bm-test-binary')).toBe(bin);
    } finally {
      process.env.PATH = old;
    }
  });

  it('returns null when nothing matches', () => {
    expect(resolveBinaryPath('definitely-not-a-real-binary-xyz')).toBeNull();
  });

  it('accepts an absolute path', () => {
    const dir = tmpDir('bm-abs-');
    const bin = path.join(dir, 'backup-mgr');
    fs.writeFileSync(bin, '');
    expect(resolveBinaryPath(bin)).toBe(bin);
  });
});

describe('compareRunningBinary', () => {
  const disk = { path: '/usr/local/bin/backup-mgr', dev: 1, ino: 42 };

  it('stays quiet when the daemon runs the current file', () => {
    const r = compareRunningBinary({ exe_path: disk.path, deleted: false, dev: 1, ino: 42 }, disk);
    expect(r.restart_needed).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('flags a daemon whose binary was replaced on disk', () => {
    const r = compareRunningBinary(
      { exe_path: '/usr/local/bin/backup-mgr (deleted)', deleted: true, dev: 1, ino: 42 },
      disk,
    );
    expect(r.restart_needed).toBe(true);
    expect(r.reason).toMatch(/replaced/);
  });

  it('flags a same-path replacement by inode', () => {
    const r = compareRunningBinary({ exe_path: disk.path, deleted: false, dev: 1, ino: 99 }, disk);
    expect(r.restart_needed).toBe(true);
  });

  it('does not flag a daemon started from a different install location', () => {
    // BACKUP_MGR_BIN may point at the build tree while the daemon runs the
    // installed copy — that is a configuration choice, not a stale build.
    const r = compareRunningBinary(
      { exe_path: '/root/.cargo/bin/backup-mgr', deleted: false, dev: 2, ino: 7 },
      disk,
    );
    expect(r.restart_needed).toBe(false);
  });

  it('stays quiet when the process cannot be inspected', () => {
    const r = compareRunningBinary(null, disk);
    expect(r.restart_needed).toBe(false);
    expect(r.running_exe).toBeNull();
  });
});

describe('installArgs', () => {
  it('gives install exactly one source and one target', () => {
    const args = installArgs('/srv/backup/target/release/backup-mgr', '/usr/local/bin/backup-mgr');
    expect(args).toEqual([
      '-m',
      '0755',
      '/srv/backup/target/release/backup-mgr',
      '/usr/local/bin/backup-mgr',
    ]);
  });

  it('never repeats the command name, which would make install expect a directory', () => {
    // `sudo -n install install -m 0755 …` makes GNU install read two sources and
    // fail with "target …: Not a directory" — the bug that made a NOPASSWD host
    // ask for a sudo password.
    expect(installArgs('/srv/a', '/usr/local/bin/backup-mgr')).not.toContain('install');
  });
});

describe('installCommandText', () => {
  it('prints the command a human would run', () => {
    const text = installCommandText('/usr/local/bin/backup-mgr');
    expect(text).toContain('cargo build --release');
    expect(text).toContain('install -m 0755 target/release/backup-mgr /usr/local/bin/backup-mgr');
  });
});
