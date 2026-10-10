import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests share one database; parallel files would contend.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
