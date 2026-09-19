import path from 'node:path';
import { parseDocument, type Document } from 'yaml';
import { readFileAs, writeFileAtomicAs, type Instance } from './instance';

export type JsonObject = Record<string, unknown>;

/**
 * config.yml belongs to one Linux user, is mode 0600, and holds that user's gpg
 * passphrase, OAuth refresh token and Discord webhook. Everything here therefore
 * goes through the instance's own identity rather than the panel's — a bug in a
 * route cannot read another user's secrets, because the panel never has the
 * permissions to.
 */

function missingConfig(inst: Instance): Error {
  return new Error(
    `cannot read ${inst.configPath} as '${inst.osUser}'. The instance may not be provisioned ` +
      'yet — an administrator can create it from the Users page.',
  );
}

/** Parse an instance's config.yml into a plain object. */
export async function readInstanceConfig(inst: Instance): Promise<JsonObject> {
  const raw = await readFileAs(inst, inst.configPath);
  if (raw === null) throw missingConfig(inst);
  return (parseDocument(raw).toJS() ?? {}) as JsonObject;
}

/**
 * Edit an instance's config.yml while preserving comments and key order, then
 * replace it atomically with owner-only permissions.
 *
 * The write happens as the owning user via a temp file in the same directory, so
 * a reader (the daemon, or the user themselves) never observes a partial file.
 */
export async function mutateInstanceConfig(
  inst: Instance,
  mutator: (doc: Document) => void,
): Promise<JsonObject> {
  const raw = await readFileAs(inst, inst.configPath);
  if (raw === null) throw missingConfig(inst);
  const doc = parseDocument(raw);
  mutator(doc);
  await writeFileAtomicAs(inst, inst.configPath, String(doc), '600');
  return (doc.toJS() ?? {}) as JsonObject;
}

/** Resolve a path from an instance's config relative to that config's directory. */
export function resolveInInstance(inst: Instance, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(path.dirname(inst.configPath), p);
}

/** Read a dotted path out of a plain object. */
export function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as JsonObject)[key];
    return undefined;
  }, obj);
}
