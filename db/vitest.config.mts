import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // These talk to one shared database; running files in parallel would let
    // them fight over the same rows.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
