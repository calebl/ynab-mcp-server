import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // Lets the Worker entry (and the OAuth provider it wraps) load under Node.
      'cloudflare:workers': fileURLToPath(new URL('./src/tests/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    server: {
      deps: {
        // Inline so the alias above applies to the provider's own import.
        inline: ['@cloudflare/workers-oauth-provider'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
