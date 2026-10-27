// Leakage tests 1-4 (docs/SPEC-BACKTEST-PLAN.md section 2). Test 5 (scrub docs added after the issue) holds by
// construction: agents only ever see a single-commit checkout of the base tree.
import fs from 'node:fs';
import path from 'node:path';
import { exec } from './exec.ts';
import type { CorpusRow } from './corpus.ts';
import { existsAt, git, grepAt, showAt } from './git.ts';
import { jaccard } from './text.ts';
import type { ParsedSpec } from './spec.ts';

/** Test 4: every cited doc exists at the base (`git cat-file -e`); key terms grepped in docs/ at the base. */
export async function docAtBaseTest(repo: string, row: CorpusRow): Promise<{ passed: boolean; detail: string[] }> {
  const detail: string[] = [];
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
  for (const d of row.issueSource.docs) {
    if (!(await existsAt(repo, row.base, d.path))) {
      detail.push(`cited doc ${d.path} does not exist at base ${row.base.slice(0, 7)} (added later or wrong path)`);
    } else if (d.quote && !norm(await showAt(repo, row.base, d.path)).includes(norm(d.quote))) {
      detail.push(`quote from ${d.path} is not verbatim in the doc at base`);
    }
  }
  const allowed = new Set([...row.acknowledgedDocHits, ...row.scrubDocs]);
  for (const term of row.keyTerms) {
    const hits = (await grepAt(repo, row.base, term, ['docs'], { word: true })).filter((h) => !allowed.has(h.split(':')[0]));
    for (const h of hits.slice(0, 5)) detail.push(`key term "${term}" appears at base: ${h.slice(0, 140)}`);
  }
  return { passed: detail.length === 0, detail };
}

/** Test 3: the agent checkout is a single-commit repo with no real remote, history or reference to the change. */
export async function historyTest(scratchRepo: string, workRoot: string, realRepo: string, row: CorpusRow): Promise<{ passed: boolean; detail: string[] }> {
  const detail: string[] = [];
  const count = parseInt((await git(scratchRepo, ['rev-list', '--all', '--count'])).trim(), 10);
  if (count !== 1) detail.push(`scratch repo has ${count} commits across refs, expected 1`);
  const known = await exec('git', ['cat-file', '-e', `${row.sha}^{commit}`], { cwd: scratchRepo });
  if (known.code === 0) detail.push(`scratch repo knows the change commit ${row.sha}`);
  const urls = (await exec('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], { cwd: scratchRepo })).stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[1]);
  const root = path.resolve(workRoot) + path.sep;
  for (const u of urls) if (!path.resolve(u).startsWith(root)) detail.push('a remote points outside the run directory');
  const rel = path.relative(path.resolve(realRepo), path.resolve(scratchRepo));
  if (!rel.startsWith('..')) detail.push('scratch repo lives inside the real repo checkout (agents could climb into it)');
  if ((await exec('git', ['ls-files', '--', 'tools/backtest', 'docs/backtest'], { cwd: scratchRepo })).stdout.trim()) detail.push('harness or corpus files present in the agent tree');
  return { passed: detail.length === 0, detail };
}

export function endpointSignature(p: ParsedSpec): Set<string> {
  return new Set(p.contract.endpoints.map((e) => `${e.method.toUpperCase()} ${e.path}`));
}

/** Test 1 verdict: spec generated from a different row's issue must differ from the true one. */
export function wrongIssueVerdict(truth: ParsedSpec, wrong: ParsedSpec): { similarity: number; passed: boolean; detail: string } {
  const text = (p: ParsedSpec) => `${p.spec.name} ${p.spec.description ?? ''} ${p.spec.contract}`;
  const similarity = jaccard(text(truth), text(wrong));
  const a = endpointSignature(truth);
  const b = endpointSignature(wrong);
  const sameEndpoints = a.size === b.size && [...a].every((x) => b.has(x));
  const passed = similarity < 0.8 && !(sameEndpoints && a.size > 0 && similarity >= 0.6);
  return { similarity, passed, detail: `token similarity ${similarity.toFixed(2)}, ${sameEndpoints ? 'same' : 'different'} endpoint set` };
}

/** All identifier-like tokens (6+ chars) in the base tree, for test 2. */
export async function baseTokenSet(repo: string, base: string): Promise<Set<string>> {
  const r = await exec('git', ['grep', '-h', '-o', '-I', '-E', '[A-Za-z_$][A-Za-z0-9_$]{5,}', base], { cwd: repo });
  return new Set(r.stdout.split('\n').filter(Boolean));
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Stream-scan a file for any marker (1 MB chunks with overlap), so large files are scanned, not skipped. */
function fileHasMarker(file: string, markers: string[]): string | null {
  if (markers.length === 0) return null;
  const latin = markers.map((m) => ({ m, l: Buffer.from(m).toString('latin1') }));
  const overlap = Math.max(...latin.map((x) => x.l.length));
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let tail = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) return null;
      const s = tail + buf.toString('latin1', 0, n);
      for (const x of latin) if (s.includes(x.l)) return x.m;
      tail = s.slice(-overlap);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Test 3, whole reachable tree: everything an agent's file tools could touch from `cwd` (its whole private root,
 * symlink targets, git pointers, the ancestor chain) holds no reference content (files of any size are scanned), no
 * escaping symlink, no hardlink to a file elsewhere, no git alternates, no worktree or commondir pointer or remote URL
 * leading outside the root, and no harness path (reference/eval/dependency roots, the real repo) is an ancestor or
 * descendant of it.
 */
export function reachabilityTest(opts: { agentRoot: string; cwd: string; forbiddenRoots: string[]; markers: string[] }): { passed: boolean; detail: string[] } {
  const detail: string[] = [];
  const root = fs.realpathSync(opts.agentRoot);
  const cwd = fs.realpathSync(opts.cwd);
  const rel = (p: string) => path.relative(root, p);
  if (!inside(cwd, root)) detail.push('cwd is outside the agent root');
  for (const f of opts.forbiddenRoots) {
    const fr = fs.existsSync(f) ? fs.realpathSync(f) : path.resolve(f);
    if (inside(root, fr)) detail.push(`a harness path (${path.basename(fr)}) is an ancestor of the agent root`);
    if (inside(fr, root)) detail.push(`a harness path (${path.basename(fr)}) lies inside the agent root`);
  }
  const markers = opts.markers.filter((m) => m.length >= 7);
  const outsideRoot = (p: string) => !inside(path.resolve(p), root);
  // Hardlinks between files inside the root are harmless (git push to the local scratch origin makes some). A file
  // with more links than we find inside the root has a link elsewhere (a way to reach or alter outside content).
  const inodes = new Map<string, { seen: number; nlink: number; path: string }>();
  const lstatChecks = (p: string, st: fs.Stats) => {
    if (!st.isFile() || st.nlink <= 1) return;
    const k = `${st.dev}:${st.ino}`;
    const e = inodes.get(k) ?? { seen: 0, nlink: st.nlink, path: p };
    e.seen++;
    inodes.set(k, e);
  };
  const stack = [root];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(p);
        } catch {
          detail.push(`dangling symlink ${rel(p)}`);
          continue;
        }
        if (!inside(target, root)) detail.push(`symlink ${rel(p)} escapes the agent root`);
        continue;
      }
      if (e.isDirectory()) {
        if (e.name === 'objects' && path.basename(d) === '.git') {
          // Packed/loose objects are compressed (markers cannot match); still check the shared-store file and hardlinks.
          if (fs.existsSync(path.join(p, 'info', 'alternates'))) detail.push('git alternates file present (shared object store)');
          const objs = [p];
          while (objs.length) {
            const od = objs.pop()!;
            for (const oe of fs.readdirSync(od, { withFileTypes: true })) {
              const op = path.join(od, oe.name);
              if (oe.isDirectory()) objs.push(op);
              else if (!oe.isSymbolicLink()) lstatChecks(op, fs.lstatSync(op));
              else detail.push(`symlink ${rel(op)} inside git objects`);
            }
          }
          continue;
        }
        stack.push(p);
        continue;
      }
      lstatChecks(p, fs.lstatSync(p));
      if (e.name === '.git') {
        // worktree pointer file: "gitdir: <path>"
        const m = fs.readFileSync(p, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (m) {
          const gitdir = path.resolve(d, m[1].trim());
          if (outsideRoot(gitdir)) detail.push(`worktree .git pointer in ${rel(d) || '.'} leads outside the agent root`);
          const cd = path.join(gitdir, 'commondir');
          if (fs.existsSync(cd) && outsideRoot(path.resolve(gitdir, fs.readFileSync(cd, 'utf8').trim()))) detail.push(`commondir of ${rel(gitdir)} leads outside the agent root`);
        }
      }
      if (e.name === 'config' && /(^|[\\/])\.git$/.test(d)) {
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/^\s*url\s*=\s*(.+)$/gm)) {
          const url = m[1].trim();
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]+@[^/]+:/.test(url) || outsideRoot(url)) detail.push(`a git remote in ${rel(d)} points outside the agent root`);
        }
      }
      const hit = fileHasMarker(p, markers);
      if (hit) detail.push(`reference marker found in ${rel(p)}`);
    }
  }
  for (const e of inodes.values()) if (e.nlink > e.seen) detail.push(`hardlink: ${rel(e.path)} has ${e.nlink - e.seen} link(s) outside the agent root`);
  return { passed: detail.length === 0, detail: [...new Set(detail)] };
}

/**
 * Reference markers for the reachability test: the change commit's shas plus added lines of the real diff that are
 * distinctive, i.e. not already in the base tree and not in `own` (the spec text the agent is legitimately given).
 */
export async function referenceMarkers(repo: string, sha: string, base: string, added: string, own = ''): Promise<string[]> {
  const full = (await git(repo, ['rev-parse', sha])).trim();
  const out = [full, full.slice(0, 7), 'reference.patch'];
  for (const raw of added.split('\n')) {
    const line = raw.trim();
    if (line.length < 24 || own.includes(line)) continue;
    const r = await exec('git', ['grep', '-q', '-F', '-e', line, base], { cwd: repo });
    if (r.code === 1) out.push(line);
    if (out.length >= 18) break;
  }
  return out;
}
