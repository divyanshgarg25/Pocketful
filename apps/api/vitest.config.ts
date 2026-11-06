import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test-db/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'json-summary'],
      // Enforced only by `npm run test:coverage` (and CI); plain `npm test` stays fast.
      thresholds: {
        // Ratchet: today's measured level, so coverage cannot silently regress. The real-database branches of
        // src/repos/* are exercised by the separate `test:db` suite and are not counted here, which is why this
        // number is below the 80% aspiration. Raise it as tests are added; never lower it.
        lines: 69,
        statements: 67,
        functions: 82,
        branches: 55,
        // Money-critical code is held to a much higher bar.
        'src/agents/guardian.ts': { lines: 95, statements: 95, functions: 95, branches: 88 },
        'src/agents/splitter.ts': { lines: 95, statements: 95, functions: 95, branches: 88 },
        'src/services/money.ts': { lines: 95, statements: 95, functions: 95, branches: 95 },
        // Step-up verification is the gate in front of every money action.
        'src/services/stepup.ts': { lines: 95, statements: 95, functions: 90, branches: 80 },
        'src/services/totp.ts': { lines: 95, statements: 90, functions: 95, branches: 75 }
      }
    }
  }
});
