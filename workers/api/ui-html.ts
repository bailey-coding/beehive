/**
 * UI HTML rendering helpers for Beehive server-rendered pages.
 * Pure functions - no I/O, no side effects.
 */

// ============================================================================
// Type safety for HTML
// ============================================================================

/**
 * Safe HTML string - can be inserted into HTML without escaping.
 * Only produce this via esc(), link(), badge(), or other trusted functions.
 */
export type SafeHtml = string & { __safeHtml: never };

/**
 * Mark a string as safe HTML (use sparingly, only for trusted content).
 */
function safeHtml(s: string): SafeHtml {
  return s as SafeHtml;
}

/**
 * Validate that a string is a SafeHtml type (type-level safety only).
 */
function isSafeHtml(_: unknown): _ is SafeHtml {
  return true; // Type guard only, no runtime check
}

// ============================================================================
// Core escaping and string helpers
// ============================================================================

/**
 * Escape HTML special characters in a string.
 * Handles: & < > " '
 */
export function esc(s: string): SafeHtml {
  return safeHtml(
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  );
}

/**
 * Convert a value to a string (empty string for null/undefined).
 * Does NOT escape - caller must escape if needed.
 */
export function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/**
 * Pick a value from a row object, trying both snake_case and camelCase.
 * Returns empty string if not found.
 */
export function pick(row: Record<string, unknown>, snake: string, camel?: string): string {
  if (row[snake] !== undefined) return str(row[snake]);
  if (camel && row[camel] !== undefined) return str(row[camel]);
  return '';
}

/**
 * Validate an ID format: alphanumeric, hyphens, underscores, 1-64 chars.
 * Rejects anything with / or other special chars that could cause path traversal.
 */
export function isValidId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// ============================================================================
// Link and navigation helpers
// ============================================================================

/**
 * Create an HTML link. The href is escaped and the text is escaped.
 * Only http(s) URLs are rendered as links; others are rendered as escaped text.
 * For non-http(s) URLs, the href is rendered as escaped text (R6).
 */
export function link(href: string, text: string): SafeHtml {
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return safeHtml(`<a href="${esc(href)}">${esc(text)}</a>`);
    }
    // Valid URL but not http/https - render href as escaped text
    return esc(href);
  } catch {
    // Not a valid URL - render href as escaped text
    return esc(href);
  }
}

/**
 * Create a link to an /app detail page.
 */
export function appLink(kind: 'orgs' | 'repos' | 'specs' | 'candidates' | 'trials', id: string, text: string): SafeHtml {
  if (!isValidId(id)) return esc(text);
  return safeHtml(`<a href="/app/${kind}/${esc(encodeURIComponent(id))}">${esc(text)}</a>`);
}

// ============================================================================
// Badges and labels
// ============================================================================

/**
 * Create a badge/pill element with escaped text.
 */
export function badge(kind: string, text: string): SafeHtml {
  const classes = {
    passed: 'badge passed',
    failed: 'badge failed',
    running: 'badge running',
    skipped: 'badge skipped',
    draft: 'badge draft',
    proposed: 'badge proposed',
    active: 'badge active',
    deprecated: 'badge deprecated',
    archived: 'badge archived',
    premerge: 'badge premerge',
    shadow: 'badge shadow',
    train: 'badge train',
    canary: 'badge canary',
    full: 'badge full',
    promotion: 'badge promotion',
    visibility: 'badge visibility',
    private: 'badge private',
    public: 'badge public',
    internal: 'badge internal',
    mock: 'badge mock',
  }[kind.toLowerCase()] || 'badge';
  return safeHtml(`<span class="${esc(classes)}">${esc(text)}</span>`);
}

/**
 * Create a visibility badge.
 */
export function visibilityBadge(visibility: string): SafeHtml {
  // badge() maps the bare visibility value (public/internal/private) to its CSS class
  return badge(visibility, visibility);
}

/**
 * Create a "Mocked" label badge.
 */
export function mockedLabel(text: string = 'Mocked'): SafeHtml {
  return badge('mock', text);
}

/**
 * Create a stage badge for oracle ladder rungs.
 */
export function stageBadge(stage: string): SafeHtml {
  const labelMap: Record<string, string> = {
    passed_premerge: 'pre-merge',
    passed_shadow: 'shadow',
    passed_train: 'train',
    passed_canary: 'canary',
    passed_full: 'full',
    promoted: 'promoted',
    pending: 'pending',
    failed: 'failed',
    rolled_back: 'rolled back',
  };
  const label = labelMap[stage] || stage;
  return badge(stage, label);
}

/**
 * Create a build status badge.
 */
export function buildBadge(status: string, rung?: string): SafeHtml {
  const text = rung ? `${status} (${rung})` : status;
  return badge(status, text);
}

// ============================================================================
// Tables
// ============================================================================

/**
 * Create an HTML table from headers and rows of plain strings.
 * All cell values are escaped.
 */
export function table(headers: string[], rows: string[][]): SafeHtml {
  if (rows.length === 0) return safeHtml('<p class="empty">None yet.</p>');
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('');
  return safeHtml(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
}

/**
 * Create an HTML table from headers and rows of pre-escaped strings.
 * Caller is responsible for ensuring all values are already escaped.
 * Use this when cells contain links or other HTML.
 */
export function tableHtml(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="empty">None yet.</p>';
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// ============================================================================
// Tabs
// ============================================================================

/**
 * Create tab navigation HTML.
 * @param base The base path for tab links (e.g., '/app/repos/abc123')
 * @param active The currently active tab name
 * @param tabs Array of tab names to display
 */
export function tabs(base: string, active: string, tabList: string[]): SafeHtml {
  const tabLinks = tabList
    .map((tab) => {
      const isActive = tab === active;
      const href = `${base}?tab=${encodeURIComponent(tab)}`;
      return `<a href="${esc(href)}" class="tab ${isActive ? 'active' : ''}">${esc(tab)}</a>`;
    })
    .join('');
  return safeHtml(`<nav class="tabs">${tabLinks}</nav>`);
}

// ============================================================================
// Full page wrapper
// ============================================================================

/**
 * Wrap content in a full HTML page with styling.
 * @param title Page title (escaped)
 * @param body HTML body content (must be SafeHtml or already escaped)
 * @param status HTTP status code
 * @param cookies Optional cookies to set
 */
export function page(title: string, body: string, status = 200, cookies: string[] = []): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - Beehive</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; }
  main { max-width: 960px; margin: 0 auto; padding: 24px; }
  h1 { margin: 0 0 16px; } h2 { margin-top: 32px; border-bottom: 1px solid #30363d; padding-bottom: 6px; }
  h3 { margin-top: 24px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .bar { display: flex; justify-content: space-between; align-items: center; }
  .subbar { display: flex; gap: 16px; align-items: center; margin-bottom: 16px; }
  
  /* Tables */
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #21262d; word-break: break-all; }
  th { background: #161b22; font-weight: 600; }
  tr:hover { background: #13171c; }
  
  /* Forms */
  input, select, textarea { background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 8px; font: inherit; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #58a6ff; }
  button { background: #238636; color: #fff; border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; font: inherit; }
  button:hover { background: #2ea043; }
  button:disabled { background: #30363d; cursor: not-allowed; }
  button.link { background: none; color: #58a6ff; padding: 0; border: none; cursor: pointer; }
  button.link:hover { text-decoration: underline; }
  form.inline { display: flex; gap: 8px; flex-wrap: wrap; }
  form.stack { display: grid; gap: 8px; }
  
  /* Tabs */
  .tabs { display: flex; gap: 8px; border-bottom: 1px solid #30363d; margin-bottom: 16px; }
  .tabs .tab { padding: 8px 12px; color: #8b949e; }
  .tabs .tab:hover { color: #e6edf3; }
  .tabs .tab.active { color: #fff; border-bottom: 2px solid #58a6ff; }
  
  /* Badges */
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
  .badge.passed { background: #12261a; color: #238636; border: 1px solid #238636; }
  .badge.failed { background: #2d1417; color: #da3633; border: 1px solid #da3633; }
  .badge.running { background: #21262d; color: #39c5cf; border: 1px solid #39c5cf; }
  .badge.skipped { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
  .badge.draft { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
  .badge.proposed { background: #211c13; color: #d1b06f; border: 1px solid #b3883e; }
  .badge.active { background: #12261a; color: #238636; border: 1px solid #238636; }
  .badge.deprecated { background: #2d1417; color: #da3633; border: 1px solid #8b0000; }
  .badge.archived { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
  .badge.premerge { background: #211c13; color: #d1b06f; border: 1px solid #b3883e; }
  .badge.shadow { background: #1a2e35; color: #39c5cf; border: 1px solid #39c5cf; }
  .badge.train { background: #2d1417; color: #da3633; border: 1px solid #da3633; }
  .badge.canary { background: #4a3818; color: #ffa630; border: 1px solid #ffa630; }
  .badge.full { background: #12261a; color: #238636; border: 1px solid #238636; }
  .badge.promoted { background: #12261a; color: #238636; border: 1px solid #238636; }
  .badge.pending { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
  .badge.rolled\ back { background: #2d1417; color: #da3633; border: 1px solid #8b0000; }
  .badge.rolled-back { background: #2d1417; color: #da3633; border: 1px solid #8b0000; }
  .badge.visibility { background: #21262d; color: #8b949e; border: 1px solid #30363d; }
  .badge.private { background: #2d1417; color: #da3633; border: 1px solid #8b0000; }
  .badge.public { background: #12261a; color: #238636; border: 1px solid #238636; }
  .badge.internal { background: #4a3818; color: #d1b06f; border: 1px solid #b3883e; }
  .badge.mock { background: #211c13; color: #8b949e; border: 1px solid #30363d; font-style: italic; }
  
  /* Flash messages */
  .flash { padding: 10px 12px; border-radius: 6px; margin-bottom: 16px; }
  .ok { background: #12261a; border: 1px solid #238636; color: #238636; }
  .err { background: #2d1417; border: 1px solid #da3633; color: #da3633; }
  .empty { color: #8b949e; font-style: italic; }
  
  /* Code and pre */
  pre { background: #161b22; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; border: 1px solid #30363d; }
  code { font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 13px; background: #161b22; padding: 2px 4px; border-radius: 3px; }
  
  /* File tree */
  details { margin-left: 16px; }
  summary { cursor: pointer; color: #58a6ff; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary::before { content: '📁 '; }
  summary[open]::before { content: '📂 '; }
  .file-item { color: #8b949e; margin-left: 8px; }
  .file-item.file::before { content: '📄 '; }
  
  /* Search */
  .search-box { margin-bottom: 16px; }
  .search-box input[type="search"] { width: 100%; max-width: 400px; }
  .search-results { margin-top: 12px; }
  .search-hit { margin-bottom: 8px; padding: 8px; background: #161b22; border-radius: 4px; }
  .search-hit .kind { color: #8b949e; font-size: 12px; margin-right: 8px; }
  .search-hit .score { color: #8b949e; font-size: 12px; float: right; }
  
  /* Changelog */
  .changelog-entry { padding: 8px 0; border-bottom: 1px solid #21262d; }
  .changelog-entry .meta { color: #8b949e; font-size: 12px; margin-bottom: 4px; }
  .changelog-entry .summary { margin: 0; }
  .changelog-entry .refs { margin-top: 4px; font-size: 13px; }
  .changelog-entry .refs a { margin-right: 8px; }
  
  /* Commit list */
  .commit { padding: 8px 0; border-bottom: 1px solid #21262d; }
  .commit .sha { font-family: monospace; color: #8b949e; font-size: 12px; }
  .commit .message { font-weight: 500; }
  .commit .author { color: #8b949e; font-size: 12px; }
  .commit .build { margin-top: 4px; font-size: 13px; }
  
  /* Details section */
  .details-section { margin: 24px 0; }
  .details-section h3 { margin-bottom: 8px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; }
  dt { color: #8b949e; text-align: right; }
  dd { margin: 0; }
  
  /* Inline code display */
  .contract-display { background: #161b22; padding: 16px; border-radius: 6px; border: 1px solid #30363d; overflow-x: auto; }
</style></head>
<body><main><h1>Beehive</h1>${body}</main></body></html>`;
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(html, { status, headers });
}
