import { NextResponse } from 'next/server';
import { guard } from '@/lib/auth';
import { pickInstance, requireProvisioned } from '@/lib/routeutil';
import { currentAction, subscribeAction, type ActionLine } from '@/lib/action-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const g = guard(req, 'dashboard.view');
  if (!g.ok) return g.response;

  const picked = pickInstance(req, g.user);
  if (!picked.ok) return picked.response;
  const inst = picked.inst;

  const notReady = await requireProvisioned(inst);
  if (notReady) return notReady;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (message: unknown): void => {
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

      const action = currentAction(inst.root);
      if (!action) {
        send({ type: 'idle' });
        finish();
        return;
      }

      send({
        type: 'snapshot',
        id: action.id,
        action: action.action,
        command: action.command,
        started_at: action.startedAt,
        status: action.status,
        exit_code: action.exitCode,
        signal: action.signal,
        error: action.error,
        output: action.output,
      });

      if (action.status !== 'running') {
        finish();
        return;
      }

      const relay = (line: ActionLine): void => {
        send(line);
        if (line.type === 'exit') finish();
      };
      const unsubscribe = subscribeAction(inst.root, relay);

      req.signal.addEventListener('abort', () => {
        unsubscribe?.();
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