import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
  test: {
    environment: 'jsdom', // DOM for the highlight matcher; harmless for the storage tests
    include: ['lib/**/*.test.ts'],
  },
});
