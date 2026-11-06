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

// DOM emulators do not implement the browser's native contenteditable command.
export function installNativeEditing(window) {
  window.document.execCommand = (command, _showUI, text) => {
    if (command !== 'insertText' && command !== 'delete') return false;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    const editor = window.document.activeElement;
    range.deleteContents();
    if (command === 'insertText') range.insertNode(window.document.createTextNode(text));
    editor.dispatchEvent(new window.InputEvent('input', {
      bubbles: true, inputType: 'insertText', data: text,
    }));
    return true;
  };
}

// Negotiate/echo the extension protocol at the mocked runtime boundary. UI tests keep
// their existing business-operation fixture; protocol reconciliation has separate real tests.
export function withSequencedPolling(handler) {
  const epoch = '11111111-1111-4111-8111-111111111111'; const reads = new Map();
  return async request => {
    if (request.path === 'poll-open') return { ok: true, data: { protocol: 1, epoch, streamId: request.data.streamId, activation: request.data.activation } };
    if (request.path !== 'poll-v2') return handler(request);
    const key = request.data.streamId + ':' + request.data.sequence;
    const result = reads.has(key) ? reads.get(key) : await handler({ ...request, path: 'poll', data: request.data.nativeProtocol === 1 ? { nativeProtocol: 1 } : {} });
    if (result?.ok) reads.set(key, result);
    if (!result?.ok || !result.data || typeof result.data !== 'object') return result;
    return { ...result, data: { ...result.data, protocol: 1, epoch, streamId: request.data.streamId, activation: request.data.activation, sequence: request.data.sequence } };
  };
}
