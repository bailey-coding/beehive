/**
 * Output Formatting Utilities
 * Handles JSON, table, and other output formats
 */

import chalk from 'chalk';

// ============================================================================
// OUTPUT FORMATTER
// ============================================================================

/**
 * Output format type
 */
export type OutputFormat = 'json' | 'table' | 'yaml' | 'compact';

/**
 * Formatted output options
 */
export interface OutputOptions {
  format: OutputFormat;
  pretty?: boolean;
  color?: boolean;
  indent?: number;
}

/**
 * Format and print output
 */
export function printOutput<T>(
  data: T,
  options?: Partial<OutputOptions>
): void {
  const opts: OutputOptions = {
    format: 'json',
    pretty: true,
    color: true,
    indent: 2,
    ...options,
  };

  const formatted = formatOutput(data, opts);
  console.log(formatted);
}

/**
 * Format output without printing
 */
export function formatOutput<T>(
  data: T,
  options: OutputOptions
): string {
  switch (options.format) {
    case 'table':
      return formatTable(data, options);
    case 'yaml':
      return formatYaml(data, options);
    case 'compact':
      return JSON.stringify(data);
    case 'json':
    default:
      return JSON.stringify(data, null, options.pretty ? options.indent : undefined);
  }
}

/**
 * Format as table
 */
function formatTable<T>(
  data: T,
  _options: OutputOptions
): string {
  // Simple table formatting for arrays of objects
  if (!Array.isArray(data)) {
    return JSON.stringify(data);
  }

  if (data.length === 0) {
    return 'No results';
  }

  // Get all keys from first item
  const keys = Object.keys(data[0] as Record<string, unknown>);
  
  // Build table
  const rows: string[] = [];
  
  // Header
  rows.push(keys.join(' | '));
  
  // Separator
  rows.push(keys.map(() => '---').join(' | '));
  
  // Data rows
  for (const item of data) {
    const values = keys.map((key) => {
      const value = (item as Record<string, unknown>)[key];
      if (value === undefined || value === null) {
        return '';
      }
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    });
    rows.push(values.join(' | '));
  }

  return rows.join('\n');
}

/**
 * Format as YAML (simplified)
 */
function formatYaml<T>(
  data: T,
  _options: OutputOptions
): string {
  return jsonToYaml(data);
}

/**
 * Simple JSON to YAML converter
 */
function jsonToYaml(
  data: unknown,
  indent: number = 2,
  depth: number = 0
): string {
  if (data === null || data === undefined) {
    return 'null';
  }

  if (typeof data === 'string') {
    // Check if it needs quoting
    if (
      data.includes(':') ||
      data.includes('\n') ||
      data.includes('"') ||
      data.startsWith(' ') ||
      data.endsWith(' ') ||
      data === ''
    ) {
      return `"${data}"`;
    }
    return data;
  }

  if (typeof data === 'number' || typeof data === 'boolean') {
    return String(data);
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return '[]';
    }
    const prefix = ' '.repeat(depth * indent);
    const items = data.map((item) => {
      const itemStr = jsonToYaml(item, indent, depth + 1);
      if (typeof item === 'object' && item !== null) {
        if (Array.isArray(item)) {
          return itemStr;
        }
        // For objects, each key gets its own line
        return itemStr
          .split('\n')
          .map((line, idx) => {
            if (idx === 0) {
              return `\n${prefix}- ${line.trim()}`;
            }
            return `  ${line.trimStart()}`;
          })
          .join('\n');
      }
      return `\n${prefix}- ${itemStr}`;
    });
    return items.join('') + '\n';
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      return '{}';
    }
    const prefix = ' '.repeat(depth * indent);
    const lines = keys.map((key) => {
      const value = obj[key];
      const valueStr = jsonToYaml(value, indent, depth + 1);
      if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value) && value.length > 0) {
          return `${prefix}${key}:${valueStr}`;
        }
        return `${prefix}${key}:\n${valueStr}`;
      }
      return `${prefix}${key}: ${valueStr}`;
    });
    return lines.join('\n');
  }

  return String(data);
}

// ============================================================================
// MESSAGE FORMATTING
// ============================================================================

/**
 * Format a success message
 */
export function formatSuccess(message: string, data?: unknown): string {
  const prefix = chalk.green('✓');
  if (data !== undefined) {
    return `${prefix} ${message}\n${formatOutput(data, { format: 'json', pretty: true })}`;
  }
  return `${prefix} ${message}`;
}

/**
 * Format an error message
 */
export function formatError(error: Error | string, code?: number): string {
  const prefix = chalk.red('✗');
  const message = typeof error === 'string' ? error : error.message;
  const lines: string[] = [`${prefix} ${message}`];
  
  if (code !== undefined) {
    lines.push(chalk.gray(`  Exit code: ${code}`));
  }
  
  // Include stack trace if verbose
  if (typeof error !== 'string' && error.stack) {
    lines.push('');
    lines.push(chalk.gray(error.stack.split('\n').slice(1).join('\n')));
  }
  
  return lines.join('\n');
}

/**
 * Format a warning message
 */
export function formatWarning(message: string): string {
  return chalk.yellow(`⚠ ${message}`);
}

/**
 * Format an info message
 */
export function formatInfo(message: string): string {
  return chalk.blue(`ℹ ${message}`);
}

/**
 * Format a debug message
 */
export function formatDebug(message: string): string {
  return chalk.gray(`🐛 ${message}`);
}

// ============================================================================
// PROGRESS INDICATOR
// ============================================================================

/**
 * Simple progress spinner
 */
export class ProgressSpinner {
  private static instance: ProgressSpinner | null = null;
  private frames: string[];
  private interval: NodeJS.Timeout | null = null;
  private enabled: boolean;
  private currentFrame: number = 0;

  constructor(enabled: boolean = true) {
    this.enabled = enabled;
    this.frames = ['|', '/', '-', '\\'];
  }

  start(message: string = 'Processing'): void {
    if (!this.enabled || this.interval) return;

    let spinnerMessage = message;
    this.interval = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      process.stdout.write(`\r${this.frames[this.currentFrame]} ${spinnerMessage}     `);
    }, 100);
  }

  update(message: string): void {
    if (!this.interval) return;
    process.stdout.write(`\r${this.frames[this.currentFrame]} ${message}     `);
  }

  stop(message: string = ''): void {
    if (!this.interval) return;
    
    clearInterval(this.interval);
    this.interval = null;
    this.currentFrame = 0;
    
    // Clear the line
    process.stdout.write(`\r${message ? message + '\n' : '       \n'}`);
  }

  static create(enabled: boolean = true): ProgressSpinner {
    if (ProgressSpinner.instance) {
      ProgressSpinner.instance.stop();
    }
    ProgressSpinner.instance = new ProgressSpinner(enabled);
    return ProgressSpinner.instance;
  }

  static getInstance(): ProgressSpinner | null {
    return ProgressSpinner.instance;
  }
}

// ============================================================================
// OUTPUT STREAM UTILITIES
// ============================================================================

/**
 * Write to stderr
 */
export function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Write to stdout
 */
export function writeOutput(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Clear the current line
 */
export function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

/**
 * Move cursor up
 */
export function cursorUp(lines: number = 1): void {
  process.stdout.write(`\x1b[${lines}A`);
}

/**
 * Move cursor down
 */
export function cursorDown(lines: number = 1): void {
  process.stdout.write(`\x1b[${lines}B`);
}

// ============================================================================
// COLOR UTILITIES
// ============================================================================

/**
 * Color map for different message types
 */
export const colors = {
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
  debug: chalk.gray,
  header: chalk.bold.cyan,
  subheader: chalk.bold,
  value: chalk.white,
  dim: chalk.dim,
  bold: chalk.bold,
};

/**
 * Colorize a value based on its type
 */
export function colorize(value: unknown): string {
  if (value === null || value === undefined) {
    return colors.dim('null');
  }

  if (typeof value === 'string') {
    if (value.startsWith('http')) {
      return colors.info(value);
    }
    return value;
  }

  if (typeof value === 'number') {
    return colors.value(String(value));
  }

  if (typeof value === 'boolean') {
    return value ? colors.success('true') : colors.error('false');
  }

  if (Array.isArray(value)) {
    return `[${value.map(colorize).join(', ')}]`;
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
}

// ============================================================================
// TABLE BUILDER (for complex tables)
// ============================================================================

/**
 * Table column definition
 */
export interface TableColumn<T> {
  header: string;
  key: string | ((item: T) => string);
  width?: number;
  align?: 'left' | 'right' | 'center';
  color?: (value: string, item: T) => string;
}

/**
 * Table options
 */
export interface TableOptions {
  padding?: number;
  border?: boolean;
  headerBorder?: boolean;
  color?: boolean;
}

/**
 * Build a table from data
 */
export function buildTable<T>(
  data: T[],
  columns: TableColumn<T>[],
  options?: TableOptions
): string {
  const opts: TableOptions = {
    padding: 1,
    border: false,
    headerBorder: true,
    color: true,
    ...options,
  };

  if (data.length === 0) {
    return 'No data';
  }

  // Calculate column widths
  const colWidths: number[] = columns.map((col, idx) => {
    const header = typeof col.header === 'function' ? col.header : col.header;
    let width = header.length + opts.padding! * 2;

    for (const item of data) {
      const value = typeof col.key === 'function' 
        ? col.key(item)
        : String((item as Record<string, unknown>)[col.key as string]);
      if (value.length + opts.padding! * 2 > width) {
        width = value.length + opts.padding! * 2;
      }
    }

    if (columns[idx].width && columns[idx].width! > width) {
      width = columns[idx].width!;
    }

    return width;
  });

  // Build lines
  const lines: string[] = [];

  // Header
  const headerParts = columns.map((col, idx) => {
    const header = typeof col.header === 'function' ? col.header : col.header;
    const width = colWidths[idx];
    const align = col.align || 'left';
    return padString(header, width, align);
  });
  lines.push(headerParts.join(opts.border ? '│' : ' '));

  // Header border
  if (opts.headerBorder) {
    const borderParts = colWidths.map((width) => '-'.repeat(width));
    lines.push(borderParts.join(opts.border ? '┼' : '+'));
  }

  // Rows
  for (const item of data) {
    const rowParts = columns.map((col, idx) => {
      let value = typeof col.key === 'function' 
        ? col.key(item)
        : String((item as Record<string, unknown>)[col.key as string]);
      
      if (col.color && opts.color) {
        value = col.color(value, item);
      }
      
      const width = colWidths[idx];
      const align = col.align || 'left';
      return padString(value, width, align);
    });
    lines.push(rowParts.join(opts.border ? '│' : ' '));
  }

  return lines.join('\n');
}

/**
 * Pad a string to a specific width with alignment
 */
function padString(
  str: string,
  width: number,
  align: 'left' | 'right' | 'center' = 'left'
): string {
  const padding = ' '.repeat(width - str.length);
  
  switch (align) {
    case 'left':
      return str + padding;
    case 'right':
      return padding + str;
    case 'center':
      const left = ' '.repeat(Math.floor(padding.length / 2));
      const right = ' '.repeat(Math.ceil(padding.length / 2));
      return left + str + right;
    default:
      return str + padding;
  }
}
