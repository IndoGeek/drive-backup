import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, isPermission, normalizePermissions } from './permissions';

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
