/**
 * PERF-015: track API response times per route so slow endpoints are visible
 * in logs without an external APM agent.
 *
 * Records `method`, `route` (Express matched path like `/api/v1/transactions/:id`),
 * `status`, and `durationMs` on `res.on('finish')`. A slow-request threshold
 * logs a warning so the first sign of a problem surfaces in the existing log
 * pipeline rather than a separate metrics store.
 */
import type { NextFunction, Request, Response } from 'express';
import { logger } from '@/utils/logger';

/** Requests taking longer than this are logged at WARN level. */
const SLOW_THRESHOLD_MS = 500;

export function responseTime(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    // req.route is set by Express after the handler matches; fall back to
    // req.path when it hasn't been set yet (e.g. 404 responses).
    const route: string = req.route?.path ?? req.path;
    const entry = {
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    };

    if (durationMs >= SLOW_THRESHOLD_MS) {
      logger.warn('Slow request', entry);
    } else {
      logger.debug('Request completed', entry);
    }
  });

  next();
}
