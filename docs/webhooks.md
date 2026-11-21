# Webhook replay protection

The backend has no inbound webhook endpoints today (payments are detected by
the Horizon stream watcher). `webhookReplayGuard` in
`src/middleware/webhookReplay.middleware.ts` is the guard any future webhook
route must mount. It is not wired to a route yet.

## Mounting

The app parses JSON globally, but the signature covers the exact raw bytes, so
the webhook router parses the body itself with `captureRawBody`. Mount the
webhook router before the global `express.json`, or make sure the raw body is
captured by whichever parser runs first.

```ts
import express, { Router } from 'express';
import { config } from '@/config/config';
import { captureRawBody, webhookReplayGuard } from '@/middleware/webhookReplay.middleware';

const router = Router();

router.post(
  '/payments',
  express.json({ limit: '100kb', verify: captureRawBody }),
  webhookReplayGuard({
    secret: config.webhooks.secret,
    toleranceSeconds: config.webhooks.toleranceSeconds,
  }),
  (req, res) => {
    // req.body is authentic, fresh and seen for the first time.
    res.json({ success: true });
  },
);
```

`webhookReplayGuard` throws at construction if the secret is empty, so a
missing `WEBHOOK_SECRET` stops the server at start-up instead of leaving the
route open.

## Header contract

| Header | Value |
|---|---|
| `X-Webhook-Timestamp` | Unix time in seconds when the sender signed the payload. |
| `X-Webhook-Signature` | `sha256=<hex>`, HMAC-SHA256 of `${timestamp}.${rawBody}` keyed with the shared secret. |

Senders can use `signWebhook(secret, rawBody, timestampSeconds)` to build the
signature.

## Responses

| Status | Reason |
|---|---|
| 401 | Missing header, malformed timestamp, timestamp outside the window (past or future), or signature mismatch. |
| 409 | The same signature was already accepted inside the window (replay). |

## Replay window

- A timestamp is accepted when it is within `toleranceSeconds` (default 300) of
  the server clock, in either direction.
- After the signature verifies, it is stored in the short-lived store for
  twice the tolerance, which covers the whole period in which it could still
  pass the timestamp check. A second delivery inside that period gets 409.
- Only validly signed requests are stored, so unauthenticated traffic cannot
  fill the store.
- Senders that retry must re-sign with a fresh timestamp, or treat 409 as
  "already delivered".

## Limits

- The store is `getRedis()` from `src/utils/redis.ts`, currently an in-memory
  stand-in. It is per process: with several instances, or after a restart,
  a payload can be replayed once per instance until its timestamp expires. A
  multi-instance deployment needs the Redis-backed client behind `getRedis()`.
- Server and sender clocks must be roughly in sync (NTP). Widen the tolerance
  only if you must; a wider window means a bigger replay store.
- The secret is never logged. Rotate it by deploying a new value to both sides.
