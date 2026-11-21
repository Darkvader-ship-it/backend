process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-for-production-use-0123456789';
process.env.DATABASE_PATH = ':memory:';
process.env.STELLAR_NETWORK = 'testnet';
process.env.STELLAR_MERCHANT_PUBLIC_KEY =
  'GDSMS3UTKQMPU5VGX4IWWUDNNX432KIBT4F3SNVKHPMSJQZOI4T5TBUK';
process.env.STELLAR_ASSET_CODE = 'USDC';
process.env.STELLAR_ASSET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
process.env.STELLAR_ASSET_RATE = '1';
process.env.STELLAR_WATCHER_ENABLED = 'false';
process.env.TAX_RATE_BPS = '0';

// Reset the database connection between every test suite so that state
// accumulated in one suite (rows, schema mutations) cannot bleed into the
// next.  Each test file gets a fresh in-memory SQLite database via
// connectDatabase(), which re-runs all migrations from scratch (#196).
import { connectDatabase, closeDatabase } from '@/utils/database';

beforeEach(async () => {
  closeDatabase();
  await connectDatabase(':memory:');
});

afterEach(() => {
  closeDatabase();
});
