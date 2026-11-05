// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/web/public/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['apps/*/src/**/*.{ts,tsx}'],
    rules: {
      // Production code logs through core/logger (structured, redacted). Raw console calls bypass that.
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }]
    }
  },
  {
    // The API logger and the web dev-log helper are the only places allowed to touch console.
    files: ['apps/api/src/core/logger.ts', 'apps/web/src/lib/log.ts'],
    rules: { 'no-console': 'off' }
  },
  {
    // Tests and scripts may log and use looser typing for fixtures.
    files: ['**/test/**', '**/test-db/**', 'scripts/**', '**/*.test.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' }
  }
);
