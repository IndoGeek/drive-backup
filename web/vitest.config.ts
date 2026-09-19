import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Route tests share a temp SQLite file, so keep each file isolated.
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@': path.resolve(process.cwd(), 'src'),
    },
  },
});
