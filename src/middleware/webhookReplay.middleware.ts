import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@/middleware/error.middleware';
import { getRedis } from '@/utils/redis';

export const WEBHOOK_TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';
const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_PREFIX = 'sha256=';
const REPLAY_KEY_PREFIX = 'webhook:replay:';

export interface WebhookReplayOptions {
  /** Shared HMAC secret. Never logged. */
  secret: string;
  /** Accepted clock skew in seconds, in both directions. Default 300. */
  toleranceSeconds?: number;
}

type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * `verify` callback for express.json(): keeps the exact bytes the sender
 * signed, because re-serialising req.body would not reproduce them.
 */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  (req as RawBodyRequest).rawBody = Buffer.from(buf);
}

/** Returns `sha256=<hex>`, the HMAC-SHA256 of `${timestamp}.${rawBody}`. */
export function signWebhook(
  secret: string,
  rawBody: string | Buffer,
  timestampSeconds: number,
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestampSeconds}.`)
    .update(rawBody)
    .digest('hex');
  return `${SIGNATURE_PREFIX}${digest}`;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function signaturesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  // timingSafeEqual throws on different lengths, so compare lengths first.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Rejects forged, stale and replayed webhooks. Mount it after
 * express.json({ verify: captureRawBody }) on the webhook route.
 *
 * 401 for missing headers, a timestamp outside the window or a bad signature;
 * 409 when an already accepted signature is presented again in the window.
 */
export function webhookReplayGuard(options: WebhookReplayOptions): RequestHandler {
  const { secret } = options;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!secret) throw new Error('webhookReplayGuard requires a non-empty secret');
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error('webhookReplayGuard toleranceSeconds must be a positive number');
  }
  // A signature stays valid for up to `tolerance` seconds on either side of
  // now, so remember it for twice that to cover the whole acceptance window.
  const replayTtlSeconds = Math.ceil(tolerance * 2);

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const timestampRaw = header(req, WEBHOOK_TIMESTAMP_HEADER);
      const signature = header(req, WEBHOOK_SIGNATURE_HEADER);
      if (!timestampRaw || !signature) {
        throw new AppError('Missing webhook signature headers', 401);
      }

      if (!/^\d{1,15}$/.test(timestampRaw)) {
        throw new AppError('Invalid webhook timestamp', 401);
      }
      const timestamp = Number.parseInt(timestampRaw, 10);
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - timestamp) > tolerance) {
        throw new AppError('Webhook timestamp outside the accepted window', 401);
      }

      const rawBody = (req as RawBodyRequest).rawBody;
      if (!rawBody) {
        // Misconfiguration: express.json({ verify: captureRawBody }) not mounted.
        throw new AppError('Webhook raw body unavailable', 500, false);
      }

      const expected = signWebhook(secret, rawBody, timestamp);
      if (!signaturesMatch(expected, signature)) {
        throw new AppError('Invalid webhook signature', 401);
      }

      // Only a validly signed request may touch the store, so unauthenticated
      // callers cannot fill it.
      const redis = getRedis();
      const key = `${REPLAY_KEY_PREFIX}${expected}`;
      if ((await redis.get(key)) !== null) {
        throw new AppError('Webhook already processed (replay detected)', 409);
      }
      await redis.set(key, '1', replayTtlSeconds);
      next();
    } catch (err) {
      next(err);
    }
  };
}
