import { defineConfig } from 'vitest/config';

// Characterization test harness for pure-logic + IndexedDB modules.
// `fake-indexeddb/auto` installs a fake `indexedDB` / `IDBKeyRange` on the
// global object so the real db layer can run under Node without a browser.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['fake-indexeddb/auto'],
    include: ['test/**/*.test.ts'],
  },
});
