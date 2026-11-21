/**
 * [TEST-008] Nock-based Horizon HTTP mock helpers.
 *
 * Usage: import { mockHorizonPayments, mockHorizonTransaction, cleanHorizonMocks }
 * in any test that needs to intercept outbound Horizon HTTP calls without hitting
 * the real testnet.
 *
 * Example:
 *   import { mockHorizonPayments, cleanHorizonMocks } from './horizon-mock';
 *   afterEach(cleanHorizonMocks);
 *   it('processes a payment', async () => {
 *     mockHorizonPayments([{ ... }]);
 *     // … run code that calls horizon service …
 *   });
 */

import nock from 'nock';

const HORIZON_BASE = process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';

export interface MockPayment {
  id: string;
  type: 'payment';
  paging_token: string;
  transaction_hash: string;
  from: string;
  to: string;
  amount: string;
  asset_type: 'credit_alphanum4' | 'native';
  asset_code?: string;
  asset_issuer?: string;
}

export interface MockTransaction {
  hash: string;
  successful: boolean;
  memo?: string;
  memo_type?: string;
  source_account: string;
  created_at: string;
}

/**
 * Intercept the Horizon /accounts/:id/payments endpoint and return the
 * provided mock payments as a HAL-paged response.
 */
export function mockHorizonPayments(
  account: string,
  payments: MockPayment[],
): nock.Scope {
  return nock(HORIZON_BASE)
    .get(`/accounts/${account}/payments`)
    .query(true)
    .reply(200, {
      _embedded: { records: payments },
      _links: { next: { href: '' } },
    });
}

/**
 * Intercept the Horizon /transactions/:hash endpoint.
 */
export function mockHorizonTransaction(tx: MockTransaction): nock.Scope {
  return nock(HORIZON_BASE)
    .get(`/transactions/${tx.hash}`)
    .reply(200, tx);
}

/** Remove all active nock interceptors. Call in afterEach. */
export function cleanHorizonMocks(): void {
  nock.cleanAll();
}

/** Assert that every registered nock interceptor was consumed. */
export function assertAllHorizonMocksConsumed(): void {
  if (!nock.isDone()) {
    const pending = nock.pendingMocks();
    throw new Error(`Unused Horizon mock interceptors:\n${pending.join('\n')}`);
  }
}
