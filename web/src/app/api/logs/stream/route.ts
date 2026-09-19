import fs from 'node:fs/promises';
import path from 'node:path';
import { backupLogDir, findLogSource, logSourceDefs } from '@/lib/logs';
import { guard } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INITIAL_BYTES = 20_000;
const POLL_MS = 1500;

export async function GET(req: Request) {
  const g = guard(req, 'logs.view');
  if (!g.ok) return g.response;

  const params = new URL(req.url).searchParams;
  const sourceId = params.get('source') ?? 'backup';
  const file = params.get('file');
  if (!file) return new Response('missing file', { status: 400 });

  let dir: string;
  try {
    const def = findLogSource(logSourceDefs(await backupLogDir()), sourceId);
    if (!def) return new Response(`unknown log source '${sourceId}'`, { status: 400 });
    dir = def.dir;
  } catch {
    return new Response('cannot read config.yml', { status: 500 });
  }

  const full = path.join(dir, path.basename(file)); // basename prevents traversal
  const encoder = new TextEncoder();

  let offset = 0;
  try {
    const st = await fs.stat(full);
    offset = Math.max(0, st.size - INITIAL_BYTES);
  } catch {
    // file may not exist yet; stream will start from 0
  }

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
          const st = await fs.stat(full);
          if (st.size < offset) offset = 0; // rotated or truncated
          if (st.size > offset) {
            const fh = await fs.open(full, 'r');
            try {
              const len = st.size - offset;
              const buf = Buffer.alloc(len);
              await fh.read(buf, 0, len, offset);
              offset = st.size;
              frame('data', buf.toString('utf8'));
            } finally {
              await fh.close();
            }
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
          // already closed
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
