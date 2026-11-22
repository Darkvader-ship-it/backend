import { createShutdown, type ShutdownServer } from '@/utils/shutdown';
import { MemoryQueue } from '@/utils/queue';

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for http.Server. `hung` keeps a request open, so close() never
 * calls back until closeAllConnections() cuts it. `slowMs` finishes the
 * close callback after a delay, as if a request were still completing.
 */
function fakeServer({ hung = false, slowMs = 0 } = {}) {
  let onClosed: (() => void) | undefined;
  const server = {
    close: jest.fn((cb?: () => void) => {
      onClosed = cb;
      if (hung) return;
      setTimeout(() => cb?.(), slowMs);
    }),
    closeIdleConnections: jest.fn(),
    closeAllConnections: jest.fn(() => setImmediate(() => onClosed?.())),
  };
  return { server, asServer: server as unknown as ShutdownServer };
}

type HarnessOptions = Partial<Parameters<typeof createShutdown>[0]> & {
  hung?: boolean;
  slowMs?: number;
};

function harness(overrides: HarnessOptions = {}) {
  const { server, asServer } = fakeServer({ hung: overrides.hung, slowMs: overrides.slowMs });
  const events: string[] = [];
  const exit = jest.fn((code: number) => events.push(`exit:${code}`));
  const stopBackground = jest.fn(() => events.push('stopBackground'));
  const flushJobs = jest.fn(async () => {
    events.push('flush');
    return 0;
  });
  const release = jest.fn(async () => {
    events.push('release');
  });
  const shutdown = createShutdown({
    server: asServer,
    timeoutMs: overrides.timeoutMs ?? 200,
    flushTimeoutMs: overrides.flushTimeoutMs ?? 200,
    stopBackground,
    flushJobs: overrides.flushJobs ?? flushJobs,
    release,
    exit,
    log: () => undefined,
    warn: () => undefined,
  });
  return { shutdown, server, exit, stopBackground, flushJobs, release, events };
}

describe('createShutdown', () => {
  it('stops background work, stops listening, flushes, releases and exits 0', async () => {
    const h = harness({ slowMs: 5 });
    const code = await h.shutdown('SIGTERM');

    expect(code).toBe(0);
    expect(h.server.close).toHaveBeenCalledTimes(1);
    expect(h.server.closeIdleConnections).toHaveBeenCalled();
    expect(h.events).toEqual(['stopBackground', 'flush', 'release', 'exit:0']);
  });

  it('waits for in-flight requests before flushing the queue', async () => {
    const events: string[] = [];
    const h = harness({
      slowMs: 60,
      timeoutMs: 500,
      flushJobs: async () => {
        events.push('flush');
        return 0;
      },
    });
    h.server.close.mockImplementationOnce((cb?: () => void) => {
      setTimeout(() => {
        events.push('closed');
        cb?.();
      }, 60);
    });
    await h.shutdown('SIGTERM');
    expect(events).toEqual(['closed', 'flush']);
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it('cuts requests still running at the deadline, flushes, and exits 1', async () => {
    const h = harness({ hung: true, timeoutMs: 40 });
    const code = await h.shutdown('SIGTERM');

    expect(code).toBe(1);
    expect(h.server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual(['stopBackground', 'flush', 'release', 'exit:1']);
  });

  it('is idempotent: a second signal is ignored and does not exit early', async () => {
    const h = harness({ hung: true, timeoutMs: 60 });
    const first = h.shutdown('SIGTERM');
    const second = h.shutdown('SIGINT');

    expect(second).toBe(first);
    await expect(first).resolves.toBe(1);
    expect(h.exit).toHaveBeenCalledTimes(1);
    expect(h.stopBackground).toHaveBeenCalledTimes(1);
    expect(h.server.close).toHaveBeenCalledTimes(1);
  });

  it('exits 0 after running a scheduled retry during flush', async () => {
    const queue = new MemoryQueue<string>('t', { attempts: 3, backoffMs: 60_000 });
    let calls = 0;
    queue.process(async () => {
      if (++calls === 1) throw new Error('transient');
    });
    queue.add('job');

    const h = harness({ flushJobs: (t) => queue.flush(t).then((r) => r.remaining) });
    await h.shutdown('SIGTERM');

    expect(calls).toBe(2);
    expect(h.exit).toHaveBeenCalledWith(0);
    queue.close();
  });

  it('waits for a running job to finish before exiting', async () => {
    const queue = new MemoryQueue<number>('t');
    let done = false;
    queue.process(async () => {
      await settle(40);
      done = true;
    });
    queue.add(1);

    const exitedWith: boolean[] = [];
    const h = harness({
      flushJobs: (t) => queue.flush(t).then((r) => r.remaining),
      timeoutMs: 500,
    });
    h.exit.mockImplementation(() => exitedWith.push(done));
    await h.shutdown('SIGTERM');

    expect(exitedWith).toEqual([true]);
  });

  it('exits 1 and reports jobs that could not run', async () => {
    const queue = new MemoryQueue<number>('t');
    queue.add(1);
    queue.add(2);

    const h = harness({
      flushJobs: (t) => queue.flush(t).then((r) => r.remaining),
      flushTimeoutMs: 30,
    });
    const code = await h.shutdown('SIGTERM');

    expect(code).toBe(1);
    expect(h.exit).toHaveBeenCalledWith(1);
  });

  it('still exits when releasing a resource throws', async () => {
    const h = harness();
    h.release.mockRejectedValueOnce(new Error('socket close failed'));
    const code = await h.shutdown('SIGTERM');

    expect(code).toBe(0);
    expect(h.exit).toHaveBeenCalledWith(0);
  });
});

describe('MemoryQueue.purgeWhere and flush', () => {
  it('removes matching jobs that are still waiting for a processor', async () => {
    const q = new MemoryQueue<{ to: string }>('t');
    q.add({ to: 'gone@example.com' });
    q.add({ to: 'keep@example.com' });
    expect(q.pending).toBe(2);

    const removed = q.purgeWhere((job) => job.to === 'gone@example.com');
    expect(removed).toBe(1);
    expect(q.pending).toBe(1);
  });
});
