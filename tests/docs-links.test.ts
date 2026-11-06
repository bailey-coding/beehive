/**
 * Every relative link in a tracked Markdown file must resolve to a file or directory in the repo.
 * Guards doc moves (docs/archive/, 2026-11-06): a renamed or archived doc fails here instead of
 * leaving a dead link. External links, anchors-only links and fenced code blocks are not checked.
 *
 * Task: docs-front-door | Spec: docs/archive/README.md
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Relative link targets in one Markdown text, fenced code removed. */
function relativeTargets(markdown: string): string[] {
  const text = markdown.replace(/```[\s\S]*?```/g, '');
  const out: string[] = [];
  for (const m of text.matchAll(LINK)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
    const path = target.split('#')[0];
    if (path) out.push(path);
  }
  return out;
}

describe('relativeTargets', () => {
  it('keeps relative and repo-root (/...) paths, drops anchors, URLs and fenced code', () => {
    const md = [
      '[a](./a.md) [b](../b.md#part) [c](https://x.test) [d](#top) [e](mailto:x@y.test) [f](/abs)',
      '```',
      '[g](./in-code.md)',
      '```',
      '[h](dir/ "title")',
    ].join('\n');
    expect(relativeTargets(md)).toEqual(['./a.md', '../b.md', '/abs', 'dir/']);
  });
});

describe('Markdown links', () => {
  it('every relative link in a tracked .md file resolves', () => {
    const files = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !f.includes('node_modules/'));
    expect(files.length).toBeGreaterThan(50);

    const broken: string[] = [];
    for (const file of files) {
      const abs = join(ROOT, file);
      if (!existsSync(abs)) continue; // deleted in the working tree, not yet staged
      for (const target of relativeTargets(readFileSync(abs, 'utf8'))) {
        let decoded = target;
        try {
          decoded = decodeURIComponent(target);
        } catch {
          // keep the raw target
        }
        // GitHub resolves a leading `/` against the repository root.
        const base = decoded.startsWith('/') ? ROOT : dirname(abs);
        if (!existsSync(normalize(join(base, decoded)))) broken.push(`${file} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
