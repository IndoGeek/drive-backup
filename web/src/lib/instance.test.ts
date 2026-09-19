import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ecosystemFor,
  existsAs,
  instanceFor,
  listFilesAs,
  provision,
  readFileAs,
  runAs,
  writeFileAs,
} from './instance';
import { instancesFile, resetInstanceOverrides } from './panel';
import { currentAccount, useSoloInstance } from './testhelp';

afterEach(() => {
  delete process.env.BACKUP_MGR_INSTANCE_TEMPLATE;
  delete process.env.BACKUP_MGR_INSTANCES_FILE;
  resetInstanceOverrides();
});

describe('instanceFor', () => {
  it('roots an instance under the account home by default', () => {
    const { account, home } = useSoloInstance();
    const inst = instanceFor(account.name);
    expect(inst?.root).toBe(path.join(home, 'backup-mgr'));
    expect(inst?.configPath).toBe(path.join(home, 'backup-mgr', 'config.yml'));
    expect(inst?.logsDir).toBe(path.join(home, 'backup-mgr', 'logs'));
    expect(inst?.historyDb).toBe(path.join(home, 'backup-mgr', 'history.db'));
  });

  it('names the pm2 app per user and gives each user their own daemon home', () => {
    const { account, home } = useSoloInstance();
    const inst = instanceFor(account.name);
    expect(inst?.pm2Name).toBe(`backup-mgr-${account.name}`);
    // A separate PM2_HOME is what makes the daemon per-user rather than shared.
    expect(inst?.pm2Home).toBe(path.join(home, '.pm2'));
    // ...and a separate rclone config keeps one user's remote credentials out of
    // another user's reach.
    expect(inst?.rcloneConfig).toBe(path.join(home, '.config', 'rclone', 'rclone.conf'));
  });

  it('supports a template override', () => {
    const { account } = useSoloInstance();
    process.env.BACKUP_MGR_INSTANCE_TEMPLATE = '/srv/instances/{home}/x';
    const inst = instanceFor(account.name);
    expect(inst?.root).toContain('/srv/instances/');
  });

  it('lets a specific account keep a non-default location (the migration path)', () => {
    const { account } = useSoloInstance();
    // useSoloInstance() has already pointed this at the current sandbox.
    const file = instancesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${account.name}:\n  root: /opt/existing-deployment\n  pm2_name: backup-mgr\n`,
    );
    resetInstanceOverrides();

    const inst = instanceFor(account.name);
    // This is what keeps a pre-existing deployment working after the migration:
    // its checkout, and its already-running pm2 app name, are preserved.
    expect(inst?.root).toBe('/opt/existing-deployment');
    expect(inst?.pm2Name).toBe('backup-mgr');
  });

  it('returns null for an account that is not mirrored', () => {
    useSoloInstance();
    expect(instanceFor('definitely-not-a-user')).toBeNull();
  });
});

describe('runAs', () => {
  it('runs a command as the owning user without sudo when they match', async () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;
    const res = await runAs(inst, 'sh', ['-c', 'echo hello']);
    expect(res.ok).toBe(true);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.viaSudo).toBe(false);
  });

  it('does not leak the panel environment into the instance', async () => {
    const { account, home } = useSoloInstance();
    process.env.A_PANEL_SECRET = 'leak-me';
    const inst = instanceFor(account.name)!;
    const res = await runAs(inst, 'sh', ['-c', 'echo "[$A_PANEL_SECRET]"']);
    // The child gets a fixed, minimal environment — never process.env.
    expect(res.stdout.trim()).toBe('[]');
    delete process.env.A_PANEL_SECRET;
    expect(inst.home).toBe(home);
  });

  it('points the instance at its own PM2_HOME and rclone config', async () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;
    const res = await runAs(inst, 'sh', ['-c', 'echo "$PM2_HOME|$RCLONE_CONFIG"']);
    expect(res.stdout.trim()).toBe(`${inst.pm2Home}|${inst.rcloneConfig}`);
  });

  it('reports a command that cannot be started', async () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;
    const res = await runAs(inst, 'definitely-not-a-command-xyz', []);
    expect(res.ok).toBe(false);
  });
});

describe('file access as the owning user', () => {
  it('round-trips a file and keeps it owner-only', async () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;
    fs.mkdirSync(inst.root, { recursive: true });
    const target = path.join(inst.root, 'note.txt');

    await writeFileAs(inst, target, 'secret contents', '600');
    expect(await readFileAs(inst, target)).toBe('secret contents');
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it('returns null for a file it cannot read', async () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;
    expect(await readFileAs(inst, path.join(inst.root, 'nope.txt'))).toBeNull();
    expect(await existsAs(inst, path.join(inst.root, 'nope.txt'))).toBe(false);
  });

  it('lists a directory with sizes and mtimes', async () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;
    fs.mkdirSync(inst.logsDir, { recursive: true });
    fs.writeFileSync(path.join(inst.logsDir, 'a.log'), 'abc');
    fs.writeFileSync(path.join(inst.logsDir, 'b b.log'), 'de');

    const files = await listFilesAs(inst, inst.logsDir);
    const byName = Object.fromEntries(files.map((f) => [f.name, f]));
    expect(byName['a.log'].size).toBe(3);
    // A space in the filename must survive the NUL-separated protocol.
    expect(byName['b b.log'].size).toBe(2);
    expect(files.every((f) => !Number.isNaN(Date.parse(f.mtime)))).toBe(true);
  });
});

describe('provision', () => {
  it('creates the directories, seeds config.yml and writes an ecosystem file', async () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;

    const result = await provision(inst);
    expect(result.ok).toBe(true);
    expect(result.created).toEqual(['config.yml', 'ecosystem.config.cjs']);
    expect(fs.existsSync(inst.configPath)).toBe(true);
    expect(fs.existsSync(inst.logsDir)).toBe(true);
    expect(fs.existsSync(inst.backupDir)).toBe(true);
    if (process.platform !== 'win32') {
      // It holds a gpg passphrase and an OAuth token.
      expect(fs.statSync(inst.configPath).mode & 0o777).toBe(0o600);
    }
  });

  it('never overwrites an existing config.yml', async () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;
    await provision(inst);
    await writeFileAs(inst, inst.configPath, 'backup:\n  prefix: "mine"\n', '600');

    const again = await provision(inst);
    expect(again.ok).toBe(true);
    expect(again.keptExisting).toContain('config.yml');
    expect(await readFileAs(inst, inst.configPath)).toContain('prefix: "mine"');
  });

  it('writes an ecosystem file scoped to this user only', () => {
    const { account } = useSoloInstance();
    const inst = instanceFor(account.name)!;
    const text = ecosystemFor(inst);
    expect(text).toContain(`daemon --config ' + path.join(ROOT, 'config.yml')`);
    expect(text).toContain(inst.pm2Name);
    // Log capture must live inside the instance, not in a shared directory.
    expect(text).toContain(`path.join(ROOT, 'logs', 'pm2.log')`);
    expect(text).not.toContain(account.home + '/backup-mgr/logs/pm2.log');
  });
});
