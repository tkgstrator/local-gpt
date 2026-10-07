import { mock } from 'bun:test';
import { createService } from '../src/server.ts';
// Exercise existing old-client contracts against source even when the generated bundle is stale.
mock.module('../dist/server.cjs', () => ({ createService }));
await import('./server.test.mjs');
await import('./parallel.test.mjs');
await import('./polling.test.mjs');
await import('./serialization.test.mjs');
await import('./response-jobs.test.mjs');
await import('./project-server.test.mjs');
await import('./extension-update-server.test.mjs');
await import('./server-port.test.mjs');
