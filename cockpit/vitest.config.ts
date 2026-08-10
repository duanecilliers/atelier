import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The cockpit's `@/` path alias (tsconfig paths) mapped for vitest. These are
// node/lib unit tests over the deterministic reader/control/roster logic - no
// jsdom, no React. Component tests are deliberately out of scope.
const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': root } },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
