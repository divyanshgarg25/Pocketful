import { defineConfig } from 'vitest/config';
// Real-Postgres suite. Serial: tests share one migrated database.
export default defineConfig({
  test: {
    include: ['test-db/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
