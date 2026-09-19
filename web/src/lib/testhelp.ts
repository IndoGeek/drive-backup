import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetOsUserCache } from './osusers';
import { resetInstanceOverrides, resetSudoFixture, type SudoFixtureEntry } from './panel';
import { resetSudoCache } from './sudo';

/**
 * Fixtures for the multi-user tests.
 *
 * The panel's identity model is Linux accounts, which tests cannot create. These
 * helpers point BACKUP_MGR_PASSWD_FILE / BACKUP_MGR_SHADOW_FILE at generated
 * files — the same overrides documented for operators — so the real code paths
 * (filtering, crypt(3), the run-as-user runner) are exercised without root.
 *
 * The *current* account is included on purpose: `runAs` skips sudo when the
 * instance belongs to the user the panel already runs as, so tests drive the
 * genuine runner rather than a stub.
 */

export type FixtureUser = {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell?: string;
};

export type Account = { name: string; uid: number; gid: number; home: string; shell: string };

/** The real account running the tests. */
export function currentAccount(): Account {
  const info = os.userInfo();
  return {
    name: info.username,
    uid: typeof process.getuid === 'function' ? process.getuid() : 1000,
    gid: typeof process.getgid === 'function' ? process.getgid() : 1000,
    home: info.homedir,
    shell: '/bin/bash',
  };
}

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writePasswdFixture(users: FixtureUser[]): string {
  const file = path.join(tmpDir('bm-passwd-'), 'passwd');
  fs.writeFileSync(
    file,
    users
      .map((u) =>
        [u.name, 'x', u.uid, u.gid, u.name, u.home, u.shell ?? '/bin/bash'].join(':'),
      )
      .join('\n') + '\n',
  );
  return file;
}

/**
 * Declare who may use sudo, instead of asking the host's sudo.
 *
 * Sudo is the source of truth for admin, so tests must control it: without this, a
 * suite would pass or fail depending on whether the machine running it happens to
 * be configured for passwordless sudo. Set `passwordless: true` to model a host
 * with `NOPASSWD` (no password is ever asked), `false` to model one that prompts.
 */
export function useSudoFixture(entries: Record<string, SudoFixtureEntry>): string {
  const file = path.join(tmpDir('bm-sudo-'), 'sudo.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  process.env.BACKUP_MGR_SUDO_FIXTURE = file;
  resetSudoFixture();
  resetSudoCache();
  return file;
}

/** Stop using a sudo fixture (and drop every cached answer). */
export function clearSudoFixture(): void {
  delete process.env.BACKUP_MGR_SUDO_FIXTURE;
  resetSudoFixture();
  resetSudoCache();
}

export function writeShadowFixture(entries: { name: string; hash: string }[]): string {
  const file = path.join(tmpDir('bm-shadow-'), 'shadow');
  fs.writeFileSync(
    file,
    entries.map((e) => [e.name, e.hash, '20000', '0', '99999', '7', '', '', ''].join(':')).join('\n') +
      '\n',
  );
  return file;
}

/**
 * A real crypt(3) hash for `password`, produced by the host — so the tests verify
 * against the same hash formats the server actually uses (sha512crypt, yescrypt).
 */
export function makeHash(password: string, salt = '$6$unittest$'): string {
  return execFileSync('perl', ['-e', 'print crypt($ARGV[0], $ARGV[1])', password, salt], {
    encoding: 'utf8',
  });
}

/** Point the OS-account lookup at a fixture and drop every cached derivation. */
export function usePasswdFixture(users: FixtureUser[]): string {
  const file = writePasswdFixture(users);
  process.env.BACKUP_MGR_PASSWD_FILE = file;
  resetOsUserCache();
  resetInstanceOverrides();
  resetSudoCache();
  return file;
}

/**
 * A single-account world: just the account this test process runs as, with its
 * instance rooted in a temp directory.
 */
export function useSoloInstance(): { account: Account; root: string; home: string } {
  const account = currentAccount();
  const sandbox = tmpDir('bm-solo-');
  const home = path.join(sandbox, 'home');
  const root = path.join(home, 'backup-mgr');
  fs.mkdirSync(home, { recursive: true });
  usePasswdFixture([{ name: account.name, uid: account.uid, gid: account.gid, home }]);
  // Everything the panel would write must land in the sandbox. Without this, a
  // test that provisions or records an override would write into the real
  // web/data — which is exactly what happened once, and must not happen again.
  process.env.BACKUP_MGR_DATA_DIR = path.join(sandbox, 'data');
  process.env.BACKUP_MGR_INSTANCES_FILE = path.join(sandbox, 'instances.yml');
  resetInstanceOverrides();
  return { account, root, home };
}
