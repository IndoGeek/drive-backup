import { describe, expect, it } from 'vitest';
import { parsePastedToken } from './rclone';

describe('parsePastedToken', () => {
  it('parses raw JSON', () => {
    const token = parsePastedToken(
      '{"access_token":"a","token_type":"Bearer","refresh_token":"r","expiry":"2030-01-01T00:00:00Z"}',
    );
    expect(token?.refresh_token).toBe('r');
  });

  it('extracts a token from a full rclone authorize block', () => {
    const output = [
      'Paste the following into your remote machine --->',
      '{"access_token":"a","token_type":"Bearer","refresh_token":"r"}',
      '<---End paste',
    ].join('\n');
    const token = parsePastedToken(output);
    expect(token?.access_token).toBe('a');
    expect(token?.refresh_token).toBe('r');
  });

  it('returns null for text without a token', () => {
    expect(parsePastedToken('nothing here')).toBeNull();
    expect(parsePastedToken('')).toBeNull();
  });
});
