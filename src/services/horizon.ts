/**
 * Thin, typed wrapper over the Horizon API. Everything that talks to the
 * network goes through here, so the rest of the app (and the tests) deal in
 * plain objects instead of SDK response types.
 */
import { Horizon, NotFoundError } from '@stellar/stellar-sdk';
import { config } from '@/config/config';
import { getRedis } from '@/utils/redis';

/** TTL for cached account balance data (#154). Short so stale balances are
 *  not served for long; long enough to absorb repeated calls within one
 *  checkout flow without hitting the Horizon rate limit. */
const BALANCE_CACHE_TTL_SECONDS = 5;

let server: Horizon.Server | null = null;
const horizon = (): Horizon.Server => (server ??= new Horizon.Server(config.stellar.horizonUrl));

// PERF-013: cap concurrent in-flight Horizon requests so an accidental fan-out
// (e.g. loading balances for every active checkout in parallel) cannot exhaust
// the HTTP connection pool or trigger Horizon's per-IP rate limit.
const MAX_CONCURRENT = 8;
let inflight = 0;
const waiters: Array<() => void> = [];

async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (inflight >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
    const next = waiters.shift();
    if (next) next();
  }
}

/** A payment-like operation credited to an account. */
export interface IncomingPayment {
  pagingToken: string;
  txHash: string;
  from: string;
  to: string;
  amount: string;
  /** "XLM" for native. */
  assetCode: string;
  assetIssuer: string | null;
}

export interface TransactionInfo {
  hash: string;
  successful: boolean;
  memo: string | null;
  memoType: string;
  sourceAccount: string;
  createdAt: string;
}

export interface Balance {
  assetCode: string;
  assetIssuer: string | null;
  balance: string;
}

type PaymentLike = {
  type: string;
  paging_token: string;
  transaction_hash: string;
  transaction_successful?: boolean;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
};

const PAYMENT_TYPES = new Set([
  'payment',
  'path_payment_strict_receive',
  'path_payment_strict_send',
]);

function normalize(record: PaymentLike): IncomingPayment | null {
  if (!PAYMENT_TYPES.has(record.type) || !record.to || !record.amount) return null;
  if (record.transaction_successful === false) return null;
  const native = record.asset_type === 'native';
  return {
    pagingToken: record.paging_token,
    txHash: record.transaction_hash,
    from: record.from ?? '',
    to: record.to,
    amount: record.amount,
    assetCode: native ? 'XLM' : (record.asset_code ?? ''),
    assetIssuer: native ? null : (record.asset_issuer ?? null),
  };
}

/** Payments to `account` after `cursor`, oldest first. Also returns the new cursor. */
export async function fetchPaymentsSince(
  account: string,
  cursor: string,
  limit = 50,
): Promise<{ payments: IncomingPayment[]; cursor: string }> {
  return withConcurrencyLimit(async () => {
    const page = await horizon()
      .payments()
      .forAccount(account)
      .cursor(cursor)
      .order('asc')
      .limit(limit)
      .call();
    const records = page.records as unknown as PaymentLike[];
    const payments = records
      .map(normalize)
      .filter((p): p is IncomingPayment => p !== null && p.to === account);
    const last = records.at(-1);
    return { payments, cursor: last ? last.paging_token : cursor };
  });
}

/** The most recent paging token for an account, so a fresh watcher skips history. */
export async function latestCursor(account: string): Promise<string> {
  return withConcurrencyLimit(async () => {
    const page = await horizon().payments().forAccount(account).order('desc').limit(1).call();
    return page.records[0]?.paging_token ?? 'now';
  });
}

export async function fetchTransaction(hash: string): Promise<TransactionInfo | null> {
  return withConcurrencyLimit(async () => {
    try {
      const tx = await horizon().transactions().transaction(hash).call();
      return {
        hash: tx.hash,
        successful: tx.successful,
        memo: tx.memo ?? null,
        memoType: tx.memo_type,
        sourceAccount: tx.source_account,
        createdAt: tx.created_at,
      };
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  });
}

export async function fetchPaymentsInTransaction(hash: string): Promise<IncomingPayment[]> {
  return withConcurrencyLimit(async () => {
    const page = await horizon().operations().forTransaction(hash).limit(100).call();
    return (page.records as unknown as PaymentLike[])
      .map(normalize)
      .filter((p): p is IncomingPayment => p !== null);
  });
}

export async function loadBalances(account: string): Promise<Balance[]> {
  // Cache Horizon account lookups to avoid repeated API calls for the same
  // account within a short window (#154). The 5-second TTL keeps balances
  // fresh enough for checkout flows while absorbing burst traffic.
  const cacheKey = `stellar:balances:${account}`;
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached) return JSON.parse(cached) as Balance[];
  } catch {
    // Cache miss or Redis error — fall through to live fetch.
  }

  const acct = await horizon().loadAccount(account);
  const balances = acct.balances.map((b) =>
    b.asset_type === 'native'
      ? { assetCode: 'XLM', assetIssuer: null, balance: b.balance }
      : 'asset_code' in b
        ? { assetCode: b.asset_code, assetIssuer: b.asset_issuer, balance: b.balance }
        : { assetCode: b.asset_type, assetIssuer: null, balance: b.balance },
  );

  try {
    await getRedis().set(cacheKey, JSON.stringify(balances), BALANCE_CACHE_TTL_SECONDS);
  } catch {
    // Best-effort cache write; a failed write still returns the live data.
  }

  return balances;
  return withConcurrencyLimit(async () => {
    const acct = await horizon().loadAccount(account);
    return acct.balances.map((b) =>
      b.asset_type === 'native'
        ? { assetCode: 'XLM', assetIssuer: null, balance: b.balance }
        : 'asset_code' in b
          ? { assetCode: b.asset_code, assetIssuer: b.asset_issuer, balance: b.balance }
          : { assetCode: b.asset_type, assetIssuer: null, balance: b.balance },
    );
  });
}
