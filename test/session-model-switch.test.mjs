import { test } from './test-support.mjs';
import assert from 'node:assert/strict';
import { createService } from '../src/server.ts';
import { selectNativeModel } from '../src/native-chat.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const THINKING = 'gpt-6-thinking', PRO = 'gpt-6-pro', INSTANT = 'gpt-6-instant';
const cid = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// Observed-style choices: Pro and Instant expose only a null effort; Thinking exposes several.
const models = { versionOptions: [
  { id: 'v', slugs: [THINKING, PRO, INSTANT], options: [
    { slug: THINKING, thinkingEffort: 'standard', isAvailable: true },
    { slug: THINKING, thinkingEffort: 'extended', isAvailable: true },
    { slug: PRO, thinkingEffort: null, isAvailable: true },
    { slug: INSTANT, thinkingEffort: null, isAvailable: true },
  ] },
] };
const selected = { slug: THINKING, thinkingEffort: 'extended', versionId: 'v' };

async function fixture(t, mode, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'model-switch-'));
  const sessionsFile = options.sessionsFile ?? join(dir, 'sessions.db');
  let service;
  const boot = async () => {
    service = createService({ host: '127.0.0.1', httpPort: 0, wsPort: 0, timeoutMs: 2000, bridgeToken: 'test', responseJobsDir: join(dir, 'jobs'), imagesDir: join(dir, 'images'), sessionsFile });
    const ports = await service.start();
    f.base = `http://127.0.0.1:${ports.httpPort}`;
    await f.bridge('poll');
    if (mode === 'native') {
      const probe = (await f.bridge('poll', { nativeProtocol: 1 })).request;
      await f.bridge('event', { type: 'native_ready', requestId: probe.requestId, protocol: 1, ready: true });
    }
  };
  const f = {
    dir,
    bridge: async (path, body = {}) => {
      const res = await fetch(f.base + '/bridge/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': 'test', 'X-Browser-Id': 'owner' }, body: JSON.stringify(body) });
      return { status: res.status, ...(await res.json()) };
    },
    post: (path, body) => fetch(f.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    session: async (extra = {}) => (await (await f.post('/v1/sessions', { projectName: null, ...extra })).json()).id,
    pair: async (id) => { const s = (await (await fetch(f.base + '/v1/sessions')).json()).data.find((x) => x.id === id); return [s.model, s.effort]; },
    restart: async () => { await service.close(); await boot(); },
    // Drives one request through sync, stream or background; returns the wire payload and a finisher.
    send: async (kind, body) => {
      let pending = null, jobId = null;
      if (kind === 'background') {
        const res = await f.post('/v1/response-jobs', { input: 'hello', ...body });
        assert.equal(res.status, 202);
        jobId = (await res.json()).id;
      } else {
        pending = f.post('/v1/responses', { input: 'hello', ...(kind === 'stream' ? { stream: true } : {}), ...body });
      }
      let request = null;
      for (let i = 0; i < 100 && !request; i++) { request = (await f.bridge('poll')).request; if (!request) await new Promise((r) => setTimeout(r, 10)); }
      assert.ok(request, 'request was dispatched');
      const ev = (v) => ({ ...v, requestId: request.requestId, ...(request.nativeUserMessageId ? { nativeUserMessageId: request.nativeUserMessageId } : {}) });
      const finish = async () => {
        if (mode === 'native') {
          assert.equal((await f.bridge('event', ev({ type: 'native_intent' }))).accepted, true);
          assert.equal((await f.bridge('event', ev({ type: 'native_identity', conversationId: cid }))).accepted, true);
        }
        await f.bridge('event', ev({ type: 'answer', text: 'ok' }));
        await f.bridge('event', ev({ type: 'stop', conversationId: cid, terminalEvidence: true }));
        if (pending) assert.equal((await pending).status, 200);
        else for (let i = 0; i < 100; i++) { if ((await (await fetch(f.base + '/v1/response-jobs/' + jobId)).json()).status === 'completed') break; await new Promise((r) => setTimeout(r, 10)); }
      };
      const refuse = async () => {
        await f.bridge('event', ev({ type: 'error', code: 'native_model_unavailable', message: 'refused', preDispatch: true }));
        if (pending) await pending;
      };
      return { request, finish, refuse };
    },
  };
  await boot();
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  return f;
}

const matrix = [];
for (const mode of ['native', 'legacy']) for (const kind of ['sync', 'stream', 'background']) matrix.push([mode, kind]);

for (const [mode, kind] of matrix) {
  test(`${mode} ${kind}: Thinking/extended session switched to Pro omits stale effort and persists the pair`, async (t) => {
    const f = await fixture(t, mode);
    const sid = await f.session({ model: THINKING, reasoning: { effort: 'extended' } });
    const run = await f.send(kind, { session_id: sid, model: PRO });
    assert.equal(run.request.model, PRO);
    assert.equal(run.request.reasoning, undefined);
    if (mode === 'native') assert.deepEqual(selectNativeModel(models, selected, run.request.model, run.request.reasoning?.effort), { model: PRO, thinkingEffort: null, versionId: 'v' });
    assert.deepEqual(await f.pair(sid), [THINKING, 'extended']);
    await run.finish();
    assert.deepEqual(await f.pair(sid), [PRO, null]);
    await f.restart();
    assert.deepEqual(await f.pair(sid), [PRO, null]);
    // The continuation uses the saved model and must not resurrect extended.
    const next = await f.send(kind, { session_id: sid });
    assert.equal(next.request.model, PRO);
    assert.equal(next.request.reasoning, undefined);
    await next.finish();
    assert.deepEqual(await f.pair(sid), [PRO, null]);
  });
}

for (const mode of ['native', 'legacy']) {
  test(`${mode}: Instant omits effort, same model inherits, explicit effort replaces`, async (t) => {
    const f = await fixture(t, mode);
    const sid = await f.session({ model: THINKING, reasoning: { effort: 'extended' } });
    let run = await f.send('sync', { session_id: sid, model: INSTANT });
    assert.equal(run.request.reasoning, undefined);
    await run.finish();
    assert.deepEqual(await f.pair(sid), [INSTANT, null]);

    const sid2 = await f.session({ model: THINKING, reasoning: { effort: 'extended' } });
    run = await f.send('sync', { session_id: sid2, model: THINKING });
    assert.deepEqual(run.request.reasoning, { effort: 'extended' });
    await run.finish();
    assert.deepEqual(await f.pair(sid2), [THINKING, 'extended']);
    run = await f.send('sync', { session_id: sid2 });
    assert.deepEqual(run.request.reasoning, { effort: 'extended' });
    await run.finish();

    run = await f.send('sync', { session_id: sid2, reasoning: { effort: 'standard' } });
    assert.equal(run.request.model, THINKING);
    assert.deepEqual(run.request.reasoning, { effort: 'standard' });
    await run.finish();
    assert.deepEqual(await f.pair(sid2), [THINKING, 'standard']);

    // Explicit effort together with a model switch is passed through and stored as given.
    run = await f.send('sync', { session_id: sid, model: THINKING, reasoning: { effort: 'standard' } });
    assert.deepEqual(run.request.reasoning, { effort: 'standard' });
    if (mode === 'native') assert.deepEqual(selectNativeModel(models, selected, run.request.model, run.request.reasoning.effort), { model: THINKING, thinkingEffort: 'standard', versionId: 'v' });
    await run.finish();
    assert.deepEqual(await f.pair(sid), [THINKING, 'standard']);
  });

  test(`${mode}: a session without a saved model never leaks its effort`, async (t) => {
    const f = await fixture(t, mode);
    const sid = await f.session({ reasoning: { effort: 'extended' } });
    const run = await f.send('sync', { session_id: sid, model: PRO });
    assert.equal(run.request.reasoning, undefined);
    await run.finish();
    assert.deepEqual(await f.pair(sid), [PRO, null]);
  });
}

test('native: pre-dispatch refusal leaves the saved model/effort pair unchanged', async (t) => {
  const f = await fixture(t, 'native');
  const sid = await f.session({ model: THINKING, reasoning: { effort: 'extended' } });
  const run = await f.send('sync', { session_id: sid, model: PRO });
  await run.refuse();
  assert.deepEqual(await f.pair(sid), [THINKING, 'extended']);
  await f.restart();
  assert.deepEqual(await f.pair(sid), [THINKING, 'extended']);
});

test('native: explicitly unsupported effort for the switched model is still refused by the selector', () => {
  assert.throws(() => selectNativeModel(models, selected, PRO, 'standard'), /native_model_unavailable/);
  const ambiguous = { versionOptions: [{ id: 'v', slugs: [THINKING], options: models.versionOptions[0].options.slice(0, 2) }] };
  assert.throws(() => selectNativeModel(ambiguous, { ...selected, slug: PRO }, THINKING), /native_reasoning_required/);
});
