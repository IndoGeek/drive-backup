import { describe, expect, it } from 'vitest';
import { buildArgs, labelFor } from './actions';

describe('buildArgs', () => {
  it('runs a plain backup', () => {
    expect(buildArgs('run', {})).toEqual(['run']);
  });

  it('passes the dry-run flag through instead of dropping it', () => {
    expect(buildArgs('run', { dryRun: true, noPtero: true })).toEqual([
      'run',
      '--dry-run',
      '--no-ptero',
    ]);
  });

  it('names the user fix-perms should grant access to', () => {
    expect(buildArgs('check', {})).toEqual(['check']);
  });

  it('fix-perms falls back to the instance user when none was given', () => {
    expect(buildArgs('fix-perms', {}, 'tanmay')).toEqual(['fix-perms', '--user', 'tanmay']);
  });

  it('fix-perms ignores the instance user when an explicit one is set', () => {
    expect(buildArgs('fix-perms', { user: 'alice' }, 'tanmay')).toEqual([
      'fix-perms',
      '--user',
      'alice',
    ]);
  });

  it('accepts an empty user for the CLI to resolve itself', () => {
    expect(buildArgs('fix-perms', {})).toEqual(['fix-perms']);
  });

  it('refuses an unknown action', () => {
    expect(buildArgs('rm-rf', {})).toBeNull();
  });

  it('restores into a target, replacing its contents by default', () => {
    expect(buildArgs('restore', { file: 'b.tar.gz', target: '/srv/restore' })).toEqual([
      'restore',
      'b.tar.gz',
      '/srv/restore',
    ]);
  });

  it('passes --merge and --force when asked', () => {
    expect(
      buildArgs('restore', { file: 'b.tar.gz', force: true, merge: true, target: '/srv/live' }),
    ).toEqual(['restore', '--force', '--merge', 'b.tar.gz', '/srv/live']);
  });
});

describe('labelFor', () => {
  it('names a dry run as a dry run', () => {
    expect(labelFor('run', { dryRun: true })).toBe('Dry run');
  });

  it('distinguishes a world backup', () => {
    expect(labelFor('run', { world: true })).toBe('World backup');
  });

  it('falls back to the plain action name', () => {
    expect(labelFor('run', {})).toBe('Run');
    expect(labelFor('something-new', {})).toBe('something-new');
  });
});
