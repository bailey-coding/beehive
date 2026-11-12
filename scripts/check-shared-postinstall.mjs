// Fails when a worker imports a zod-using workers/shared module but lacks the shared `postinstall`.
// CI's clean install pre-installs shared and workers share one checkout, so the build alone masks the gap
// (docs/OPEN-QUESTIONS.md 2026-11-12). Usage: node scripts/check-shared-postinstall.mjs
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..', 'workers');
const SKIP = new Set(['node_modules', 'tests', 'dist']);
const importRe = /(?:from|import)\s+['"]([^'"]+)['"]/g;

function tsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (SKIP.has(n)) return [];
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return n.endsWith('.ts') && !n.endsWith('.test.ts') ? [p] : [];
  });
}

const importsOf = (f) => [...readFileSync(f, 'utf8').matchAll(importRe)].map((m) => m[1]);
const resolveLocal = (from, spec) => {
  const base = resolve(dirname(from), spec);
  return [base, `${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p) && statSync(p).isFile());
};

// A shared file needs zod when it imports it or imports a shared file that does.
const shared = tsFiles(join(root, 'shared'));
const needsZod = new Set(shared.filter((f) => importsOf(f).includes('zod')));
for (let grew = true; grew; ) {
  grew = false;
  for (const f of shared) {
    if (needsZod.has(f)) continue;
    if (importsOf(f).some((s) => s.startsWith('.') && needsZod.has(resolveLocal(f, s)))) {
      needsZod.add(f);
      grew = true;
    }
  }
}

const bad = [];
for (const w of readdirSync(root)) {
  const pkgPath = join(root, w, 'package.json');
  if (w === 'shared' || !existsSync(pkgPath)) continue;
  const hit = tsFiles(join(root, w)).find((f) =>
    importsOf(f).some((s) => s.startsWith('.') && needsZod.has(resolveLocal(f, s))));
  const post = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts?.postinstall ?? '';
  if (hit && !post.includes('--prefix ../shared')) bad.push(`${w} (via ${hit.replace(root + '/', '')})`);
}

if (bad.length) {
  console.error(`Missing "postinstall": "npm install --prefix ../shared ..." in:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log(`ok: every worker importing a zod-using shared module installs shared (${needsZod.size} such modules)`);
