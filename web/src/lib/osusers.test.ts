import { afterEach, describe, expect, it } from 'vitest';
import { getOsUser, listOsUsers, preferredAdmin } from './osusers';
import { usePasswdFixture } from './testhelp';

const USERS = [
  { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/bash' },
  { name: 'daemon', uid: 1, gid: 1, home: '/usr/sbin', shell: '/usr/sbin/nologin' },
  { name: 'postgres', uid: 998, gid: 998, home: '/var/lib/postgresql', shell: '/bin/bash' },
  { name: 'alice', uid: 1000, gid: 1000, home: '/home/alice' },
  { name: 'bob', uid: 1001, gid: 1001, home: '/home/bob' },
  { name: 'svc', uid: 1002, gid: 1002, home: '/srv/svc', shell: '/usr/sbin/nologin' },
];

function setup(): void {
  delete process.env.BACKUP_MGR_MIN_UID;
  delete process.env.BACKUP_MGR_EXCLUDE_USERS;
  delete process.env.BACKUP_MGR_INCLUDE_ROOT;
  delete process.env.BACKUP_MGR_ADMIN_USER;
  usePasswdFixture(USERS);
}

afterEach(() => {
  setup();
});

setup();

describe('which accounts are mirrored', () => {
  it('includes root and human accounts, ordered by uid', () => {
    expect(listOsUsers().map((u) => u.username)).toEqual(['root', 'alice', 'bob']);
  });

  it('skips service accounts: nologin shells and uid below the threshold', () => {
    const names = listOsUsers().map((u) => u.username);

    expect(names).not.toContain('daemon');
    expect(names).not.toContain('svc');
    expect(names).not.toContain('postgres');
  });

  it('honours a raised uid threshold', () => {
    process.env.BACKUP_MGR_MIN_UID = '2000';
    usePasswdFixture(USERS);
    expect(listOsUsers().map((u) => u.username)).toEqual(['root']);
  });

  it('can be told to leave root out', () => {
    process.env.BACKUP_MGR_INCLUDE_ROOT = '0';
    usePasswdFixture(USERS);
    expect(listOsUsers().map((u) => u.username)).toEqual(['alice', 'bob']);
  });

  it('honours an exclusion list', () => {
    process.env.BACKUP_MGR_EXCLUDE_USERS = 'alice, bob';
    usePasswdFixture(USERS);
    expect(listOsUsers().map((u) => u.username)).toEqual(['root']);
  });

  it('marks which accounts carry uid 0', () => {
    const root = listOsUsers().find((u) => u.username === 'root');
    expect(root?.privileged).toBe(true);
    expect(listOsUsers().find((u) => u.username === 'alice')?.privileged).toBe(false);
  });
});

describe('getOsUser', () => {
  it('finds a mirrored account', () => {
    expect(getOsUser('alice')?.home).toBe('/home/alice');
  });

  it('refuses an account that is not mirrored', () => {
    expect(getOsUser('svc')).toBeNull();
    expect(getOsUser('postgres')).toBeNull();
    expect(getOsUser('nobody')).toBeNull();
  });

  it('rejects anything that is not a plain account name', () => {
    expect(getOsUser('../../etc/passwd')).toBeNull();
    expect(getOsUser('alice bob')).toBeNull();
    expect(getOsUser('alice;id')).toBeNull();
    expect(getOsUser('')).toBeNull();
  });
});

describe('preferredAdmin', () => {
  it('picks the lowest-uid human account, not root', () => {
    expect(preferredAdmin()).toBe('alice');
  });

  it('can be overridden explicitly', () => {
    process.env.BACKUP_MGR_ADMIN_USER = 'bob';
    expect(preferredAdmin()).toBe('bob');
  });

  it('falls back to root when no human account exists', () => {
    usePasswdFixture([USERS[0], USERS[1]]);
    expect(preferredAdmin()).toBe('root');
  });
});
