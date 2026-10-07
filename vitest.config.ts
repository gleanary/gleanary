import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next', 'e2e'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      // Not dead config: in vitest v4 every file loaded during the run is
      // reported regardless of `include`; these keep the .tsx components
      // loaded by jsdom tests out of the (TS-only) coverage gate.
      exclude: ['src/app/**/*.tsx', 'src/components/**/*.tsx'],
      // Baseline measured 2026-07-15: statements 78.7%,
      // branches 70.6%, functions 78.9%, lines 80.6%. Set just below so
      // regressions fail CI; raise as coverage improves.
      thresholds: {
        statements: 78,
        branches: 70,
        functions: 78,
        lines: 80,
      },
    },
    setupFiles: ['__tests__/mocks/msw-setup.ts'],
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `server-only` throws when imported outside a bundler that applies the
      // `react-server` condition. Under vitest (plain node) it should be a
      // no-op, so alias it to the package's empty stub.
      'server-only': path.resolve(__dirname, 'node_modules/server-only/empty.js'),
    },
  },
});
