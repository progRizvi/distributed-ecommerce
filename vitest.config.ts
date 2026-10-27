import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Many files start at once (PGlite loads WebAssembly, some tests import the whole app), so 5 s is too tight.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
