import { Horizon } from '@stellar/stellar-sdk';
import { STELLAR_REQUEST_TIMEOUT_MS } from '@/services/horizon';

describe('Stellar SDK request timeout', () => {
  it('sets a 30-second default for Horizon network requests', () => {
    expect(STELLAR_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(Horizon.AxiosClient.defaults.timeout).toBe(STELLAR_REQUEST_TIMEOUT_MS);
  });

  it('overrides longer per-request timeouts used by SDK operations', async () => {
    let requestTimeout: number | undefined;

    await Horizon.AxiosClient.get('https://horizon.example.test/', {
      timeout: 60_000,
      adapter: async (request) => {
        requestTimeout = request.timeout;
        return {
          data: {},
          headers: {},
          status: 200,
          statusText: 'OK',
          config: request,
        };
      },
    });

    expect(requestTimeout).toBe(STELLAR_REQUEST_TIMEOUT_MS);
  });
});