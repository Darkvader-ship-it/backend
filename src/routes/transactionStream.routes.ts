/**
 * GET /api/v1/transactions/stream
 *
 * Server-Sent Events endpoint for real-time transaction notifications (#150).
 * Streams `transaction:new`, `transaction:updated`, and `payment:confirmed`
 * events to authenticated clients that prefer a plain HTTP connection over
 * Socket.IO.
 */
import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware';
import { logger } from '@/utils/logger';

const router = Router();

/** Map of active SSE response objects, keyed by a simple connection counter. */
const clients = new Map<number, { res: import('express').Response; userId: string }>();
let nextClientId = 0;

/** Broadcast a typed event to every SSE subscriber. */
export function broadcastSSE(event: string, data: unknown): void {
  if (clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res } of clients.values()) {
    try {
      res.write(payload);
    } catch {
      // Client already disconnected; will be cleaned up on the 'close' listener.
    }
  }
}

router.get('/stream', authenticate, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering.
  res.flushHeaders();

  // Send a heartbeat comment every 25 s to keep the connection alive through
  // proxies that close idle connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);

  const clientId = nextClientId++;
  clients.set(clientId, { res, userId: req.user!.sub });
  logger.debug(`SSE client connected: ${req.user!.email} (id=${clientId})`);

  // Send a connected confirmation so the client knows the stream is live.
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(clientId);
    logger.debug(`SSE client disconnected: id=${clientId}`);
  });
});

export default router;
