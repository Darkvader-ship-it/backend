import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger';

type Handler<T> = (data: T) => Promise<void> | void;

export interface JobOptions {
  /** Total tries including the first. */
  attempts?: number;
  /** Delay before the first retry; doubles each time. */
  backoffMs?: number;
}

export interface FailedJob<T> {
  /** Stable id used to inspect and requeue the entry. */
  id: string;
  /** Name of the queue the job failed in. */
  queue: string;
  data: T;
  error: string;
  /** Stack trace of the final failure, when the thrown value had one. */
  stack?: string;
  attempts: number;
  failedAt: string;
}

const DEFAULTS: Required<JobOptions> = { attempts: 5, backoffMs: 1_000 };
const MAX_DEAD = 100;

/**
 * In-process job queue with Bull's add/process shape, so a Redis-backed Bull
 * queue can replace it later without call-site changes.
 *
 * - Retries failed jobs with exponential backoff (1s, 2s, 4s, ... by default).
 * - Jobs added before a processor registers wait instead of being dropped.
 * - Jobs that exhaust their attempts go to a bounded dead-letter list for
 *   inspection, and are logged; nothing ever throws to the caller.
 */
export class MemoryQueue<T = unknown> {
  private handler: Handler<T> | null = null;
  private waiting: { data: T; opts: Required<JobOptions> }[] = [];
  private timers = new Set<NodeJS.Timeout>();
  readonly dead: FailedJob<T>[] = [];
  private active = 0;

  constructor(
    readonly name: string,
    private readonly defaults: Required<JobOptions> = DEFAULTS,
  ) {}

  process(handler: Handler<T>): void {
    this.handler = handler;
    const queued = this.waiting.splice(0);
    for (const job of queued) this.run(job.data, job.opts, 1);
  }

  add(data: T, opts: JobOptions = {}): void {
    const full = { ...this.defaults, ...opts };
    if (!this.handler) {
      this.waiting.push({ data, opts: full });
      return;
    }
    this.run(data, full, 1);
  }

  /**
   * Moves a dead-letter entry back onto the queue with a fresh attempt budget.
   * Returns false when no entry has that id.
   */
  requeue(id: string): boolean {
    const index = this.dead.findIndex((job) => job.id === id);
    if (index === -1) return false;
    const [job] = this.dead.splice(index, 1);
    logger.info(`Queue ${this.name}: requeued dead-letter job ${id}`);
    this.add(job.data);
    return true;
  }

  /** Jobs still running or scheduled for a retry. */
  get pending(): number {
    return this.active + this.timers.size + this.waiting.length;
  }

  /** Cancels scheduled retries (graceful shutdown, tests). */
  close(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private run(data: T, opts: Required<JobOptions>, attempt: number): void {
    this.active++;
    setImmediate(async () => {
      try {
        await this.handler!(data);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        if (attempt < opts.attempts) {
          const delay = opts.backoffMs * 2 ** (attempt - 1);
          logger.warn(
            `Queue ${this.name}: attempt ${attempt} failed (${error}); retrying in ${delay}ms`,
          );
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            this.run(data, opts, attempt + 1);
          }, delay);
          timer.unref();
          this.timers.add(timer);
        } else {
          logger.error(`Queue ${this.name}: job failed after ${attempt} attempts`, { error });
          this.dead.unshift({
            id: randomUUID(),
            queue: this.name,
            data,
            error,
            stack,
            attempts: attempt,
            failedAt: new Date().toISOString(),
          });
          this.dead.length = Math.min(this.dead.length, MAX_DEAD);
        }
      } finally {
        this.active--;
      }
    });
  }
}

export const QUEUE_NAMES = ['notifications', 'receipts'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

let queues: Map<QueueName, MemoryQueue> | null = null;

export function setupQueues(): void {
  queues = new Map(QUEUE_NAMES.map((name) => [name, new MemoryQueue(name)]));
}

export function getQueue<T = unknown>(name: QueueName): MemoryQueue<T> {
  if (!queues) throw new Error('Queues not initialized. Call setupQueues() first.');
  const queue = queues.get(name);
  if (!queue) throw new Error(`Unknown queue: ${name}`);
  return queue as MemoryQueue<T>;
}

export function closeQueues(): void {
  queues?.forEach((q) => q.close());
}

/** Dead-letter entries across all queues (or one), newest first. */
export function listDeadLetters(queue?: QueueName): FailedJob<unknown>[] {
  if (!queues) return [];
  const sources = queue ? [queues.get(queue)] : [...queues.values()];
  return sources
    .flatMap((q) => (q ? q.dead : []))
    .sort((a, b) => b.failedAt.localeCompare(a.failedAt));
}

/** Requeues a dead-letter entry on its owning queue. False when the id is unknown. */
export function requeueDeadLetter(id: string): boolean {
  if (!queues) return false;
  for (const q of queues.values()) {
    if (q.requeue(id)) return true;
  }
  return false;
}
