import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The suites here talk to a real Postgres and spawn real workers. They are integration
    // tests on purpose — the guarantees this project makes are about crashes, locks and
    // transactions, none of which survive being mocked out.
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,   // they share one database
    env: { APOLLO_FIXTURES: '1' },
  },
});
