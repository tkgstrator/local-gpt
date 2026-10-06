import { execFileSync } from 'node:child_process';
import { validateExtensionRelease } from './extension-release.mjs';

const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
function snapshot(ref) {
  git(['rev-parse', '--verify', ref + '^{commit}']);
  const paths = git(['ls-tree', '-r', '-z', '--name-only', ref, '--', 'src', 'extension', 'scripts/build.mjs',
    'scripts/update-extension.mjs', 'scripts/extension-updater.mjs', 'scripts/extension-release.mjs',
    'package.json', 'bun.lock']).split('\0').filter(Boolean);
  return new Map(paths.map(path => [path, git(['show', ref + ':' + path])]));
}
const base = process.argv[2];
if (!base || !/^[0-9a-f]{40}$/.test(base)) throw new Error('Provide an explicit base commit SHA');
const result = validateExtensionRelease(snapshot(base), snapshot('HEAD'));
console.log('Extension version ' + result.version + ' validated (' + result.changed.length + ' changed browser inputs).');
