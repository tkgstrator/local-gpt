import { test as bunTest } from 'bun:test';
// Keep fixture cleanup explicit while using Bun's native runner.
export function test(name, optionsOrFn, maybeFn) {
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  const timeout = typeof optionsOrFn === 'object' ? optionsOrFn.timeout : 10000;
  bunTest(name, async () => {
    const cleanups = [];
    try { await fn({ after: cleanup => cleanups.push(cleanup) }); }
    finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
  }, timeout);
}
