import { posix } from 'node:path';

export function compareVersions(a, b) {
  const parse = value => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('Invalid extension version');
    return value.split('.').map(Number);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

function browserInputs(files) {
  const inputs = new Set(['scripts/build.mjs', 'scripts/update-extension.mjs', 'scripts/extension-updater.mjs',
    'scripts/extension-release.mjs', 'package.json', 'bun.lock']);
  for (const path of files.keys()) if (path.startsWith('extension/')) inputs.add(path);
  const visit = path => {
    if (inputs.has(path)) return;
    inputs.add(path);
    const source = files.get(path) ?? '';
    const imports = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]/g;
    for (const match of source.matchAll(imports)) {
      const base = posix.normalize(posix.join(posix.dirname(path), match[1] ?? match[2]));
      const target = [base, base + '.ts', base + '.js', base + '/index.ts'].find(p => files.has(p));
      if (target) visit(target);
    }
  };
  for (const entry of ['src/extension-page.ts', 'src/extension-content.ts', 'src/extension-background.ts', 'src/userscript.ts']) visit(entry);
  inputs.add('src/userscript.header.txt');
  return inputs;
}

function comparable(path, value) {
  if (path === 'extension/manifest.json' && value) {
    const manifest = JSON.parse(value);
    delete manifest.version;
    return JSON.stringify(manifest);
  }
  if (path === 'src/userscript.header.txt') return value?.replace(/(@version\s+)\S+/, '$1VERSION');
  return value;
}

export function validateExtensionRelease(before, after) {
  const oldVersion = JSON.parse(before.get('extension/manifest.json')).version;
  const newVersion = JSON.parse(after.get('extension/manifest.json')).version;
  const headerVersion = after.get('src/userscript.header.txt')?.match(/@version\s+(\S+)/)?.[1];
  if (newVersion !== headerVersion) throw new Error('Extension and userscript versions must match');
  const inputs = new Set([...browserInputs(before), ...browserInputs(after)]);
  const changed = [...inputs].filter(path => comparable(path, before.get(path)) !== comparable(path, after.get(path)));
  if (compareVersions(newVersion, oldVersion) < 0 || (changed.length && compareVersions(newVersion, oldVersion) <= 0))
    throw new Error('Browser artifacts changed: increase the extension version. Changed inputs: ' + changed.join(', '));
  return { version: newVersion, changed };
}
