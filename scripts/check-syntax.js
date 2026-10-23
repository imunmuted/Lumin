import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const SKIP = new Set(['node_modules', '.git', '.render', 'coverage']);
async function collect(directory) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) { if (!SKIP.has(item.name)) result.push(...await collect(path.join(directory, item.name))); }
    else if (item.isFile() && item.name.endsWith('.js')) result.push(path.join(directory, item.name));
  }
  return result;
}
const files = await collect(ROOT);
let failed = 0;
for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) { failed++; process.stderr.write(`\n[syntax] ${path.relative(ROOT, file)}\n${check.stderr || check.stdout}`); }
}
if (failed) { process.stderr.write(`\nSyntax check failed for ${failed}/${files.length} files.\n`); process.exitCode = 1; }
else process.stdout.write(`Syntax check passed for ${files.length} JavaScript files.\n`);
