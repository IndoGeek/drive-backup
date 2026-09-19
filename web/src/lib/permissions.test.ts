import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  INSTANCE_PERMISSIONS,
  PERMISSIONS,
  isPermission,
  normalizePermissions,
} from './permissions';

describe('permissions', () => {
  it('recognises valid permission keys', () => {
    expect(isPermission('config.edit')).toBe(true);
    expect(isPermission('config.delete')).toBe(false);
    expect(isPermission(42)).toBe(false);
  });

  it('normalizes input: filters unknown values and de-duplicates', () => {
    expect(normalizePermissions(['config.edit', 'config.edit', 'nope', 7])).toEqual([
      'config.edit',
    ]);
  });

  it('returns an empty list for non-arrays', () => {
    expect(normalizePermissions(undefined)).toEqual([]);
    expect(normalizePermissions('config.edit')).toEqual([]);
  });

  it('exposes every permission through ALL_PERMISSIONS', () => {
    expect(ALL_PERMISSIONS).toContain('backup.restore');
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });
});

describe('permission scopes', () => {
  it('scopes every permission so the UI can warn about privileged ones', () => {
    for (const p of PERMISSIONS) {
      expect(['instance', 'panel']).toContain(p.scope);
    }
  });

  it('treats the privileged, panel-wide permissions as panel-scoped', () => {
    const scope = (key: string) => PERMISSIONS.find((p) => p.key === key)?.scope;
    expect(scope('users.manage')).toBe('panel');
    expect(scope('binary.install')).toBe('panel');
  });

  it('grants a new user only instance-scoped permissions', () => {
    // This is what makes "every Linux account can sign in" safe: the default set
    // can only ever touch the holder's own instance.
    expect(INSTANCE_PERMISSIONS).toContain('config.edit');
    expect(INSTANCE_PERMISSIONS).toContain('daemon.control');
    expect(INSTANCE_PERMISSIONS).toContain('backup.restore');
    expect(INSTANCE_PERMISSIONS).not.toContain('users.manage');
    expect(INSTANCE_PERMISSIONS).not.toContain('binary.install');
  });

  it('covers every instance-scoped permission exactly once', () => {
    const expected = PERMISSIONS.filter((p) => p.scope === 'instance').map((p) => p.key);
    expect([...INSTANCE_PERMISSIONS].sort()).toEqual([...expected].sort());
  });
});
