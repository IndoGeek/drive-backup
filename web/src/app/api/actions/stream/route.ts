import { binaryPath } from '@/lib/panel';
import { spawnAs } from '@/lib/instance';
import { prepareAction, type ActionOptions } from '@/lib/actions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const maxDuration = 7200;

export async function POST(req: Request) {
  let body: { action?: string; options?: ActionOptions } | null = null;
  try {
    body = (await req.json()) as { action?: string; options?: ActionOptions };
  } catch {
    body = null;
  }

  const prepared = await prepareAction(req, body);
  if (!prepared.ok) return prepared.response;
  const { inst, args, command, timeout } = prepared;

  const encoder = new TextEncoder();
  const fullArgs = [...args, '--config', inst.configPath];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (message: Record<string, unknown>): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
        } catch {
          closed = true;
        }
      };
      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
        }
      };

      send({ type: 'start', command });

      let child: ReturnType<typeof spawnAs>;
      try {
        child = spawnAs(inst, binaryPath(), fullArgs);
      } catch (e) {
        send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
        finish();
        return;
      }

      const timer = setTimeout(() => {
        send({ type: 'stderr', data: `\n[timed out after ${timeout / 1000}s]\n` });
        child.kill('SIGTERM');
      }, timeout);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => send({ type: 'stdout', data: chunk }));
      child.stderr.on('data', (chunk: string) => send({ type: 'stderr', data: chunk }));

      child.on('error', (err) => {
        clearTimeout(timer);
        send({ type: 'error', message: err.message });
        finish();
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        send({ type: 'exit', code, signal, ok: code === 0 });
        finish();
      });

      req.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGTERM');
        finish();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
