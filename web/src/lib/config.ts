import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, type Document } from 'yaml';
import { configPath } from './env';

export type JsonObject = Record<string, unknown>;

/** Parse config.yml into a plain object. */
export async function readConfig(): Promise<JsonObject> {
  const raw = await fs.readFile(configPath(), 'utf8');
  const doc = parseDocument(raw);
  return (doc.toJS() ?? {}) as JsonObject;
}

/**
 * Edit config.yml in place while preserving comments and key order, then write
 * it atomically with owner-only permissions (it holds secrets).
 */
export async function mutateConfig(
  mutator: (doc: Document) => void,
): Promise<JsonObject> {
  const p = configPath();
  const raw = await fs.readFile(p, 'utf8');
  const doc = parseDocument(raw);
  mutator(doc);
  const text = String(doc);
  const tmp = `${p}.web-${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, p);
  await fs.chmod(p, 0o600).catch(() => {});
  return (doc.toJS() ?? {}) as JsonObject;
}

/** Resolve a path from config relative to the config file's directory. */
export function resolveInConfig(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(path.dirname(configPath()), p);
}

/** Read a dotted path out of a plain object. */
export function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as JsonObject)[key];
    return undefined;
  }, obj);
}
