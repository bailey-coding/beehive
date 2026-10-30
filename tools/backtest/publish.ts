// Committed result summaries: a run's report.md reduced to a summary (no candidate source, no tokens, no home paths).
import { redact } from './client.ts';

export function sanitizeReport(md: string, opts: { name: string; home?: string }): string {
  let t = md.replace(/```[\s\S]*?```/g, '(code block removed)');
  if (opts.home) t = t.split(opts.home).join('~');
  t = t.replace(/\/home\/[A-Za-z0-9_-]+/g, '~');
  const lines = t.split('\n').map(redactLine);
  const header = [
    `<!-- Summary of run ${opts.name}, published by \`npm run backtest -- publish\`. The full run directory (docs/backtest/runs/) is git-ignored because it holds candidate outputs. -->`,
    '',
  ];
  return [...header, ...lines].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Redact token-shaped substrings without trimming the line. */
function redactLine(l: string): string {
  return redact(l, Number.MAX_SAFE_INTEGER).replace(/^\.\.\./, '');
}
