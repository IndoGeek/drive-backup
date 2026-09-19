import fs from 'node:fs/promises';
import path from 'node:path';
import { backupLogDir, findLogSource, logSourceDefs } from '@/lib/logs';
import { runAs, type Instance } from '@/lib/instance';
import { guard } from '@/lib/auth';
import { pickInstance } from '@/lib/routeutil';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INITIAL_BYTES = 20_000;
const POLL_MS = 1500;

async function sizeOf(inst: Instance, full: string, access: 'instance' | 'panel'): Promise<number | null> {
  if (access === 'panel') {
    try {
      return (await fs.stat(full)).size;
    } catch {
      return null;
    }
  }
  const res = await runAs(inst, 'stat', ['-c', '%s', '--', full], { timeoutMs: 15_000 });
  if (!res.ok) return null;
  const n = Number(res.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

async function readFrom(
  inst: Instance,
  full: string,
  offset: number,
  access: 'instance' | 'panel',
): Promise<string | null> {
  if (access === 'panel') {
    try {
      const st = await fs.stat(full);
      const len = st.size - offset;
      if (len <= 0) return '';
      const fh = await fs.open(full, 'r');
      try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        return buf.toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  }

  const res = await runAs(inst, 'tail', ['-c', `+${offset + 1}`, '--', full], { timeoutMs: 15_000 });
  return res.ok ? res.stdout : null;
}

export async function GET(req: Request) {
  const g = guard(req, 'logs.view');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const params = new URL(req.url).searchParams;
  const sourceId = params.get('source') ?? 'backup';
  const file = params.get('file');
  if (!file) return new Response('missing file', { status: 400 });

  const def = findLogSource(logSourceDefs(inst, await backupLogDir(inst)), sourceId);
  if (!def) return new Response(`unknown log source '${sourceId}'`, { status: 400 });

  const full = path.join(def.dir, path.basename(file));
  const encoder = new TextEncoder();

  let offset = 0;
  const size = await sizeOf(inst, full, def.access);
  if (size !== null) offset = Math.max(0, size - INITIAL_BYTES);

  let closed = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  const stopPolling = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const frame = (event: string, data: string) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      const tick = async () => {
        if (closed) return;
        try {
          const current = await sizeOf(inst, full, def.access);
          if (current === null) {
            frame('error', 'cannot read log file');
            return;
          }
          if (current < offset) offset = 0;
          if (current > offset) {
            const chunk = await readFrom(inst, full, offset, def.access);
            if (chunk === null) {
              frame('error', 'cannot read log file');
              return;
            }
            offset += Buffer.byteLength(chunk, 'utf8');
            frame('data', chunk);
          } else {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          }
        } catch (e) {
          frame('error', e instanceof Error ? e.message : 'read error');
        }
      };

      void tick();
      interval = setInterval(() => void tick(), POLL_MS);

      const stop = () => {
        if (closed) return;
        closed = true;
        stopPolling();
        try {
          controller.close();
        } catch {
        }
      };
      req.signal.addEventListener('abort', stop);
    },
    cancel() {
      closed = true;
      stopPolling();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
