import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', '.render', 'coverage']);
async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) files.push(...await collect(path.join(directory, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path.join(directory, entry.name));
  }
  return files;
}

const files = await collect(ROOT);
const missing = [];
const importPattern = /(?:\bfrom\s*|\bimport\s*)['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] || match[2];
    const candidate = path.resolve(path.dirname(file), specifier);
    const choices = [candidate, `${candidate}.js`, `${candidate}.json`, `${candidate}.node`, path.join(candidate, 'index.js')];
    let exists = false;
    for (const choice of choices) {
      try { if ((await stat(choice)).isFile()) { exists = true; break; } } catch {}
    }
    if (!exists) missing.push(`${path.relative(ROOT, file)} -> ${specifier}`);
  }
}

const source = await readFile(path.join(ROOT, 'dashboard/server.js'), 'utf8');
const manifestPath = path.join(ROOT, 'api/route-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const routePattern = /router\.(get|post|put|delete|patch)\(\s*(['"`])([^'"`]+)\2/gi;
const actual = new Set([...source.matchAll(routePattern)]
  .map(match => [match[1].toUpperCase(), match[3]])
  .filter(([, route]) => route !== '/')
  .map(([method, route]) => `${method} ${route}`));
const declared = new Set(manifest.routes.map(route => `${route.method} ${route.path}`));
const unlistedRoutes = [...actual].filter(route => !declared.has(route));
const staleRoutes = [...declared].filter(route => !actual.has(route));
if (missing.length || unlistedRoutes.length || staleRoutes.length || manifest.routeCount !== declared.size) {
  for (const issue of missing) process.stderr.write(`Missing import: ${issue}\n`);
  for (const route of unlistedRoutes) process.stderr.write(`Route missing from manifest: ${route}\n`);
  for (const route of staleRoutes) process.stderr.write(`Stale route in manifest: ${route}\n`);
  process.stderr.write(`Route manifest count is ${manifest.routeCount}; actual unique route count is ${actual.size}.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Import and route-manifest checks passed (${files.length} JavaScript files; ${actual.size} non-root routes).\n`);
}
