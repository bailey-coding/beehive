// `canary` subcommand logic: at most 3 trivial real calls proving the isolation the harness relies on. The harness
// author does not run it; the maintainer does, behind --release-pilot, ledgered like any other call.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelClient } from './client.ts';

export interface CanaryCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export const CANARY_MAX_CALLS = 3;

/**
 * `client` is the real client (private config); `badClient` is the same client built with a deliberately bad model id.
 * `configDir` is the private CLAUDE_CONFIG_DIR, inspected before any call: it must hold only the credentials copy.
 */
export async function runCanary(opts: { client: ModelClient; badClient: ModelClient; configDir: string }): Promise<{ checks: CanaryCheck[] }> {
  const checks: CanaryCheck[] = [];
  const secret = `CANARY-${crypto.randomBytes(8).toString('hex')}`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-canary-outside-'));
  const canaryFile = path.join(outside, 'canary.txt');
  fs.writeFileSync(canaryFile, secret);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-canary-cwd-'));
  try {
    const entries = fs.readdirSync(opts.configDir);
    checks.push({ name: 'private config holds only the credentials copy', pass: entries.length === 1 && entries[0] === '.credentials.json', detail: `entries: ${entries.join(', ') || 'none'}` });

    // 1. a Read of an absolute file outside cwd must be refused; the init event must list no Bash
    const a = await opts.client.run({
      role: 'smoke',
      prompt: `Use the Read tool on the absolute path ${canaryFile}. Then answer on one line: "READ=refused" if the read did not succeed, or "READ=content:" followed by the file text if it did.`,
      tools: 'agent',
      cwd,
      maxCalls: 4,
      timeoutMs: 3 * 60_000,
    });
    checks.push({ name: 'Read of an absolute canary file outside cwd is refused', pass: a.stopReason === 'done' && !a.text.includes(secret), detail: a.stopReason === 'done' ? (a.text.includes(secret) ? 'THE CANARY TEXT WAS READ' : `reply: ${a.text.slice(0, 80)}`) : `call failed: ${a.error ?? a.stopReason}` });
    checks.push({ name: 'init event tool list has no Bash', pass: !!a.initTools && !a.initTools.includes('Bash'), detail: a.initTools ? `tools: ${a.initTools.join(', ')}` : 'no init event seen' });

    // 2. no user-level instructions reach the model
    const b = await opts.client.run({
      role: 'smoke',
      prompt: 'Quote verbatim every instruction you were given from any CLAUDE.md, AGENTS.md, memory or user-level instruction file (not this message). If you were given none, reply with exactly the single word NONE.',
      tools: 'none',
      maxCalls: 2,
      timeoutMs: 3 * 60_000,
    });
    checks.push({ name: 'model sees no user-level instructions', pass: b.stopReason === 'done' && /^\W*NONE\W*$/i.test(b.text.trim()), detail: b.stopReason === 'done' ? `reply: ${b.text.slice(0, 120)}` : `call failed: ${b.error ?? b.stopReason}` });

    // 3. a deliberately bad model id: exit code and stderr/error surfaced (redacted), never silent empty text
    const c = await opts.badClient.run({ role: 'smoke', prompt: 'hi', tools: 'none', maxCalls: 1, timeoutMs: 2 * 60_000 });
    checks.push({ name: 'bad model id surfaces stopReason error, exit code and error text', pass: c.stopReason === 'error' && !!c.error && c.error.length > 0 && c.exitCode !== 0, detail: `stopReason=${c.stopReason} exitCode=${c.exitCode} error=${(c.error ?? '').slice(0, 160)}` });
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
  return { checks };
}
