import { defineConfig } from 'vitest/config';

// Figure-detection evaluation (not part of `npm test`): see README.md here.
export default defineConfig({
  test: { environment: 'node', include: ['scripts/figure-eval/*.eval.ts'], testTimeout: 1_800_000 },
});
