import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@/middleware/error.middleware';

export interface ApiVersionOptions {
  /** When the version was (or will be) deprecated. Setting either date marks it deprecated. */
  deprecatedAt?: Date;
  /** When the version stops working. Sent as an HTTP-date in the `Sunset` header. */
  sunsetAt?: Date;
}

/**
 * Tags every response from a versioned router with `X-API-Version`. A deprecated version also
 * gets `Deprecation` (RFC 9745) and, if a sunset date is known, `Sunset` (RFC 8594).
 * Mount it before the routes: `app.use('/api/v1', apiVersion('1'))`.
 */
export function apiVersion(version: string, options: ApiVersionOptions = {}): RequestHandler {
  const { deprecatedAt, sunsetAt } = options;
  const deprecated = deprecatedAt !== undefined || sunsetAt !== undefined;

  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-API-Version', version);
    if (deprecated) {
      // RFC 9745 wants a structured date (`@<unix seconds>`); `true` when no date is known.
      res.setHeader(
        'Deprecation',
        deprecatedAt ? `@${Math.floor(deprecatedAt.getTime() / 1000)}` : 'true',
      );
      if (sunsetAt) res.setHeader('Sunset', sunsetAt.toUTCString());
    }
    next();
  };
}

const VERSION_IN_PATH = /^\/api\/v(\d+)(?:[/?]|$)/;

/**
 * Rejects `/api/v<N>/...` requests whose version is not supported with a 404 that lists the
 * versions that are. Requests for supported versions, and for paths outside `/api/v<N>`, pass
 * through. Mount it after the versioned routers and before `notFoundHandler`.
 */
export function unsupportedApiVersion(supported: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const match = VERSION_IN_PATH.exec(req.originalUrl);
    if (!match || supported.includes(match[1])) {
      next();
      return;
    }
    const list = supported.map((v) => `v${v}`).join(', ');
    const message = `API version v${match[1]} is not supported. Supported versions: ${list}`;
    next(new AppError(message, 404));
  };
}
