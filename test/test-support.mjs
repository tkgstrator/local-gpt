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
