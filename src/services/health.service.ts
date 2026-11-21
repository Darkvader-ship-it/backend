import { config } from '@/config/config';
import * as horizon from '@/services/horizon';
import { isDatabaseHealthy } from '@/utils/database';
import { getRedis } from '@/utils/redis';
import { logger } from '@/utils/logger';

export type DependencyStatus = 'up' | 'down' | 'timeout';

export interface DependencyMetric {
  status: DependencyStatus;
  responseTimeMs: number;
}

export interface HealthReport {
  healthy: boolean;
  checks: {
    database: DependencyMetric;
    redis: DependencyMetric;
    horizon: DependencyMetric;
  };
}

/**
 * Probes every dependency the API needs. Each probe is bounded by
 * `timeoutMs`, so the endpoint answers quickly even when Horizon hangs.
 * Failure details go to the log; the report carries status and response time metrics.
 */
export async function checkHealth(timeoutMs = config.health.timeoutMs): Promise<HealthReport> {
  const t0Db = Date.now();
  const dbOk = isDatabaseHealthy();
  const dbMs = Date.now() - t0Db;
  const database: DependencyMetric = {
    status: dbOk ? 'up' : 'down',
    responseTimeMs: dbMs,
  };
  if (!dbOk) logger.warn('Health: database probe failed');

  const t0Redis = Date.now();
  let redisStatus: DependencyStatus = 'up';
  try {
    await getRedis().get('health:ping');
  } catch {
    redisStatus = 'down';
  }
  const redisMs = Date.now() - t0Redis;
  const redis: DependencyMetric = {
    status: redisStatus,
    responseTimeMs: redisMs,
  };

  const t0Horizon = Date.now();
  const horizonStatus = await probeHorizonStatus(timeoutMs);
  const horizonMs = Date.now() - t0Horizon;
  const horizonMetric: DependencyMetric = {
    status: horizonStatus,
    responseTimeMs: horizonMs,
  };

  return {
    healthy: database.status === 'up' && horizonStatus === 'up' && redis.status === 'up',
    checks: { database, redis, horizon: horizonMetric },
  };
}

async function probeHorizonStatus(timeoutMs: number): Promise<DependencyStatus> {
  try {
    await horizon.probeHorizon(timeoutMs);
    return 'up';
  } catch (err) {
    const name = (err as Error).name;
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    const reason = timedOut ? 'timed out' : 'failed';
    logger.warn(`Health: Horizon probe ${reason}: ${(err as Error).message}`);
    return timedOut ? 'timeout' : 'down';
  }
}
