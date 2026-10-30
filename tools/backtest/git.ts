// Git helpers. Everything the harness does to the real repo is read-only; scratch repos live under a run dir.
import fs from 'node:fs';
import path from 'node:path';
import { exec } from './exec.ts';

export async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const r = await exec('git', args, { cwd, input });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr.trim().slice(0, 500)}`);
  return r.stdout;
}

/** `git cat-file -e <rev>:<path>` as a boolean (leakage test 4). */
export async function existsAt(repo: string, rev: string, file: string): Promise<boolean> {
  const r = await exec('git', ['cat-file', '-e', `${rev}:${file}`], { cwd: repo });
  return r.code === 0;
}

export async function showAt(repo: string, rev: string, file: string): Promise<string> {
  return git(repo, ['show', `${rev}:${file}`]);
}

export async function commitMessage(repo: string, sha: string): Promise<{ subject: string; body: string }> {
  const out = await git(repo, ['log', '-1', '--format=%s%x00%b', sha]);
  const [subject, body] = out.split('\0');
  return { subject: subject.trim(), body: (body ?? '').trim() };
}

export async function parentOf(repo: string, sha: string): Promise<string> {
  return (await git(repo, ['rev-parse', `${sha}^`])).trim();
}

export async function changedFiles(repo: string, sha: string): Promise<string[]> {
  const out = await git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', sha]);
  return out.split('\n').filter(Boolean);
}

/** `git grep -n -i -F` of a term in a tree, limited to pathspecs. Returns matching "path:line:text" lines. */
export async function grepAt(repo: string, rev: string, term: string, pathspecs: string[], opts: { word?: boolean; ignoreCase?: boolean } = {}): Promise<string[]> {
  const args = ['grep', '-n', '-F', ...(opts.ignoreCase === false ? [] : ['-i']), ...(opts.word ? ['-w'] : []), '-e', term, rev, '--', ...pathspecs];
  const r = await exec('git', args, { cwd: repo });
  if (r.code === 1) return [];
  if (r.code !== 0) throw new Error(`git grep failed: ${r.stderr.slice(0, 300)}`);
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(rev.length + 1));
}

export function isTestFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(file) || /\.(test|spec)\.tsx?$/.test(file) || /\.test-d\.ts$/.test(file);
}

export function isDocFile(file: string): boolean {
  return file.startsWith('docs/') || /\.md$/.test(file);
}

/** Unified diff of a commit against its parent (for the reference arm and the overlap test). Harness-only. */
export async function diffOf(repo: string, sha: string): Promise<string> {
  return git(repo, ['diff', '--binary', '--no-renames', `${sha}^`, sha]);
}

export async function addedLinesOf(repo: string, sha: string): Promise<string> {
  const d = await git(repo, ['diff', '-U0', '--no-renames', `${sha}^`, sha]);
  return d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
}

/** Single-commit scratch repo holding only the base tree: no history, no real remotes (leakage test 3). */
export async function createScratchRepo(sourceRepo: string, baseSha: string, dir: string, scrub: string[] = []): Promise<{ repo: string; origin: string }> {
  const repo = path.join(dir, 'repo');
  const origin = path.join(dir, 'origin.git');
  const tar = path.join(dir, 'base.tar');
  fs.mkdirSync(repo, { recursive: true });
  await git(sourceRepo, ['archive', '--format=tar', '-o', tar, baseSha]);
  const t = await exec('tar', ['-xf', tar, '-C', repo]);
  if (t.code !== 0) throw new Error(`tar failed: ${t.stderr}`);
  fs.rmSync(tar);
  for (const f of scrub) fs.rmSync(path.join(repo, f), { force: true });
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'backtest@beehive.invalid']);
  await git(repo, ['config', 'user.name', 'Backtest Harness']);
  await git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'node_modules\n.vitest-cache\ntest-results\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'base']);
  await git(dir, ['init', '-q', '--bare', origin]);
  await git(repo, ['remote', 'add', 'origin', origin]);
  await git(repo, ['push', '-q', 'origin', 'main']);
  return { repo, origin };
}

export async function addWorktree(repo: string, wt: string, branch: string): Promise<void> {
  await git(repo, ['worktree', 'add', '-q', '-b', branch, wt, 'main']);
}

/** Commit everything in a worktree and push to the scratch origin (always-pushed invariant, scratch only). */
export async function commitAndPush(wt: string, branch: string, message: string): Promise<string> {
  await git(wt, ['add', '-A']);
  const st = await git(wt, ['status', '--porcelain']);
  if (st.trim()) await git(wt, ['commit', '-q', '-m', message]);
  await git(wt, ['push', '-q', 'origin', `${branch}:refs/heads/scratch/${branch.replace(/^work\//, '')}`]);
  return (await git(wt, ['rev-parse', 'HEAD'])).trim();
}

export function linkNodeModules(root: string, wt: string): void {
  const dest = path.join(wt, 'node_modules');
  if (!fs.existsSync(dest)) fs.symlinkSync(path.join(root, 'node_modules'), dest, 'dir');
}
