// Private Claude CLI config for one harness run: only a copy of the login credentials. No CLAUDE.md, settings, memory,
// plugins, skills or history, so user-level instructions cannot contaminate any arm. Lives in its own top-level temp
// root (never inside an agent root), mode 0700/0600, and is deleted by dispose(). Contents are never read or printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PrivateConfig {
  /** Value for CLAUDE_CONFIG_DIR. */
  dir: string;
  /** Value for HOME (empty, private): keeps ~/.claude.json and friends out of reach too. */
  home: string;
  dispose(): void;
}

export const CREDENTIALS_NAME = '.credentials.json';

export function createPrivateConfig(srcCredentials = path.join(os.homedir(), '.claude', CREDENTIALS_NAME)): PrivateConfig {
  if (!fs.existsSync(srcCredentials)) throw new Error(`no ${CREDENTIALS_NAME} at the user's Claude config dir: log in with the claude CLI first (the harness never uses API keys from the environment)`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-claude-cfg-'));
  fs.chmodSync(root, 0o700);
  const dir = path.join(root, 'config');
  const home = path.join(root, 'home');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  const dest = path.join(dir, CREDENTIALS_NAME);
  fs.copyFileSync(srcCredentials, dest);
  fs.chmodSync(dest, 0o600);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    fs.rmSync(root, { recursive: true, force: true });
  };
  process.once('exit', dispose);
  return { dir, home, dispose };
}
