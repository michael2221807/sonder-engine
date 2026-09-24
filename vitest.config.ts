import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';
import { plotVectorSandbox } from './build/plot-vector-sandbox';

export default defineConfig({
  plugins: [plotVectorSandbox()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'src/lab/**'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      include: ['src/engine/**/*.ts'],
      exclude: [
        'src/engine/**/*.test.ts',
        'src/engine/**/__test-utils__/**',
        'src/engine/types/**',
        'src/engine/stores/**',
      ],
      reporter: ['text', 'text-summary', 'lcov'],
    },
  },
});
