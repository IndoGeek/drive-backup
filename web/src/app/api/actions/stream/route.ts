import { NextResponse } from 'next/server';
import { binaryPath } from '@/lib/panel';
import { prepareAction, type ActionOptions } from '@/lib/actions';
import { startAction, subscribeAction, type ActionLine } from '@/lib/action-store';

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

  const { action, alreadyRunning } = startAction(inst, {
    action: body?.action ?? '',
    args,
    command: `${binaryPath()} ${[...args, '--config', inst.configPath].join(' ')}`,
    timeout,
  });
  if (alreadyRunning) {
    return NextResponse.json(
      {
        error: 'an action is already running for this instance',
        running: true,
        id: action.id,
        action: action.action,
        started_at: action.startedAt,
      },
      { status: 409 },
    );
  }

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

      send({ type: 'start', id: action.id, command });

      const relay = (line: ActionLine): void => {
        send(line);
        if (line.type === 'exit') finish();
      };
      const unsubscribe = subscribeAction(inst.root, relay);
      if (action.status !== 'running') {
        relay({
          type: 'exit',
          code: action.exitCode,
          signal: action.signal,
          ok: action.exitCode === 0,
        });
      }

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