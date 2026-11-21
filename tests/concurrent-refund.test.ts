/**
 * [TEST-006] Concurrent refund race-condition tests.
 *
 * Two simultaneous refund requests for the same completed transaction must
 * result in exactly one success (200) and one idempotency / status conflict
 * (409). The SQLite transaction in TransactionModel.refund uses a
 * SERIALIZABLE-equivalent isolation level via better-sqlite3's synchronous API,
 * so the second writer sees the already-refunded status and throws.
 */

import { api, bearer, createProduct, createSale, signUp, useDatabase } from './helpers';

useDatabase();

describe('[TEST-006] concurrent refund', () => {
  let admin: string;

  beforeAll(async () => {
    admin = (await signUp()).token;
  });

  /** Complete a pending sale with a card payment so it becomes refundable. */
  async function completeSale(saleId: string): Promise<void> {
    await api()
      .post('/api/v1/payments')
      .set(bearer(admin))
      .send({ transactionId: saleId, method: 'card' })
      .expect(201);
  }

  it('allows only one of two simultaneous refund requests to succeed', async () => {
    const product = await createProduct(admin, { priceCents: 500, stock: 10 });
    const sale = await createSale(admin, [{ productId: product.id, quantity: 1 }]);
    await completeSale(sale.id);

    // Fire both refund requests at exactly the same time.
    const [r1, r2] = await Promise.all([
      api()
        .post(`/api/v1/transactions/${sale.id}/refund`)
        .set(bearer(admin))
        .send({ reason: 'concurrent test A' }),
      api()
        .post(`/api/v1/transactions/${sale.id}/refund`)
        .set(bearer(admin))
        .send({ reason: 'concurrent test B' }),
    ]);

    const statuses = [r1.status, r2.status].sort();

    // One must succeed (200) and one must fail with a conflict (409).
    expect(statuses).toEqual([200, 409]);

    // The transaction must end up in the refunded state exactly once.
    const detail = await api()
      .get(`/api/v1/transactions/${sale.id}`)
      .set(bearer(admin))
      .expect(200);
    expect(detail.body.data.status).toBe('refunded');
  });

  it('a second refund on an already-refunded transaction returns 409', async () => {
    const product = await createProduct(admin, { priceCents: 300, stock: 5 });
    const sale = await createSale(admin, [{ productId: product.id, quantity: 1 }]);
    await completeSale(sale.id);

    // First refund — must succeed.
    await api()
      .post(`/api/v1/transactions/${sale.id}/refund`)
      .set(bearer(admin))
      .send({})
      .expect(200);

    // Second refund on the same transaction — must be rejected.
    const second = await api()
      .post(`/api/v1/transactions/${sale.id}/refund`)
      .set(bearer(admin))
      .send({})
      .expect(409);

    expect(second.body).toMatchObject({ error: expect.any(String) });
  });

  it('a pending (not yet paid) transaction cannot be refunded', async () => {
    const product = await createProduct(admin, { priceCents: 200, stock: 3 });
    const sale = await createSale(admin, [{ productId: product.id, quantity: 1 }]);

    // No payment step — sale is still pending.
    await api()
      .post(`/api/v1/transactions/${sale.id}/refund`)
      .set(bearer(admin))
      .send({})
      .expect(409);
  });
});
