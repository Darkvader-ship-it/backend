import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { config } from '@/config/config';
import { allQueues } from '@/utils/queue';

/**
 * Prometheus metrics. Label values are bounded on purpose: `route` is the
 * Express route template (e.g. /api/v1/products/:id), never the raw URL, and
 * every unmatched path shares the single value "unmatched". A scrape therefore
 * stays small no matter what clients request.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'stellarpos_' });

const UNMATCHED = 'unmatched';

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds, by route template',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests served. Error rate is the share with status_code 5xx or 4xx.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [registry],
});

export const stellarTransactions = new Counter({
  name: 'stellar_transactions_total',
  help: 'Stellar payments processed by the backend, by source and outcome',
  // source: checkout_request (QR checkout settled by the watcher or verify call),
  //         manual_hash (cashier submitted a hash), watcher (memo matched, amount wrong)
  // outcome: settled | rejected
  labelNames: ['source', 'outcome'] as const,
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'queue_depth',
  help: 'Jobs waiting, running or scheduled for retry, by queue',
  labelNames: ['queue'] as const,
  registers: [registry],
  collect() {
    for (const q of allQueues()) this.set({ queue: q.name }, q.pending);
  },
});

export const queueDeadLetters = new Gauge({
  name: 'queue_dead_letters',
  help: 'Jobs that exhausted their attempts and sit in the dead-letter list, by queue',
  labelNames: ['queue'] as const,
  registers: [registry],
  collect() {
    for (const q of allQueues()) this.set({ queue: q.name }, q.dead.length);
  },
});

// Key business and technical indicators (#131)
export const paymentFailures = new Counter({
  name: 'payment_failures_total',
  help: 'Total number of payment failures by payment method and failure reason',
  labelNames: ['method', 'reason'] as const,
  registers: [registry],
});

export const transactionsCreated = new Counter({
  name: 'transactions_created_total',
  help: 'Total transactions created',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const transactionRate = new Gauge({
  name: 'transaction_rate_per_minute',
  help: 'Estimated transaction throughput per minute',
  registers: [registry],
});

/** Route template for a finished request, or "unmatched" when no route handled it. */
export function routeLabel(req: Request): string {
  const path = req.route?.path;
  if (typeof path !== 'string') return UNMATCHED;
  const base = req.baseUrl ?? '';
  // A router's root route ("/") should read as the mount point, not with a trailing slash.
  return path === '/' ? base || '/' : `${base}${path}`;
}

/** Records latency and count for every request once its response has finished. */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status_code: String(res.statusCode),
    };
    httpRequestDuration.observe(labels, seconds);
    httpRequests.inc(labels);
  });
  next();
}

/** Constant-time check of "Bearer <METRICS_TOKEN>". Always true when no token is configured. */
export function metricsAuthorized(header: string | undefined): boolean {
  const token = config.metrics.token;
  if (!token) return true;
  const expected = Buffer.from(`Bearer ${token}`);
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const METRICS_CONTENT_TYPE = registry.contentType;
