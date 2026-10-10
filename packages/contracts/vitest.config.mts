import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Only the sources. Without this the compiled copies under dist/ are
    // collected too and every test runs twice.
    include: ['src/**/*.test.ts'],
  },
});
