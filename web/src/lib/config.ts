import path from 'node:path';
import { parseDocument, type Document } from 'yaml';
import { readFileAs, writeFileAtomicAs, type Instance } from './instance';

export type JsonObject = Record<string, unknown>;

function missingConfig(inst: Instance): Error {
  return new Error(
    `cannot read ${inst.configPath} as '${inst.osUser}'. The instance may not be provisioned ` +
      'yet — an administrator can create it from the Users page.',
  );
}

export async function readInstanceConfig(inst: Instance): Promise<JsonObject> {
  const raw = await readFileAs(inst, inst.configPath);
  if (raw === null) throw missingConfig(inst);
  return (parseDocument(raw).toJS() ?? {}) as JsonObject;
}

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

export function resolveInInstance(inst: Instance, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(path.dirname(inst.configPath), p);
}

export function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object') return (acc as JsonObject)[key];
    return undefined;
  }, obj);
}
