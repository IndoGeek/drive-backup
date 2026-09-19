import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetOsUserCache } from './osusers';
import { resetInstanceOverrides, resetSudoFixture, type SudoFixtureEntry } from './panel';
import { resetSudoCache } from './sudo';

export type FixtureUser = {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell?: string;
};

export type Account = { name: string; uid: number; gid: number; home: string; shell: string };

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

export function useSudoFixture(entries: Record<string, SudoFixtureEntry>): string {
  const file = path.join(tmpDir('bm-sudo-'), 'sudo.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  process.env.BACKUP_MGR_SUDO_FIXTURE = file;
  resetSudoFixture();
  resetSudoCache();
  return file;
}

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

export function makeHash(password: string, salt = '$6$unittest$'): string {
  return execFileSync('perl', ['-e', 'print crypt($ARGV[0], $ARGV[1])', password, salt], {
    encoding: 'utf8',
  });
}

export function usePasswdFixture(users: FixtureUser[]): string {
  const file = writePasswdFixture(users);
  process.env.BACKUP_MGR_PASSWD_FILE = file;
  resetOsUserCache();
  resetInstanceOverrides();
  resetSudoCache();
  return file;
}

export function useSoloInstance(): { account: Account; root: string; home: string } {
  const account = currentAccount();
  const sandbox = tmpDir('bm-solo-');
  const home = path.join(sandbox, 'home');
  const root = path.join(home, 'backup-mgr');
  fs.mkdirSync(home, { recursive: true });
  usePasswdFixture([{ name: account.name, uid: account.uid, gid: account.gid, home }]);

  process.env.BACKUP_MGR_DATA_DIR = path.join(sandbox, 'data');
  process.env.BACKUP_MGR_INSTANCES_FILE = path.join(sandbox, 'instances.yml');
  resetInstanceOverrides();
  return { account, root, home };
}
