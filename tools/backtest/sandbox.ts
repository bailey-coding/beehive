// OS isolation for running agent-written code (candidate tests, candidate config, spec acceptance tests) with the tools
// this host has: `unshare` user + mount + pid + net namespaces and a chroot onto a minimal root. Inside: no network
// (a fresh netns has only a down loopback), no view of the real filesystem beyond read-only system dirs, the
// dependency tree (read-only) and the evaluation root (read-write), a private tmpfs HOME and TMPDIR, scrubbed env.
// If it cannot be set up, callers must refuse to run the code: there is no silent fallback.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { exec, type ExecResult } from './exec.ts';

export class SandboxUnavailable extends Error {}

export interface Box {
  /** Working directory inside the box (must be under a rw path). */
  cwd: string;
  /** Read-write bind mounts (same absolute path inside). */
  rw: string[];
  /** Read-only binds, `path` or `visiblePath=realSource` (a dependency tree reached through a symlink chain). */
  ro: string[];
}

// A fresh netns has a DOWN loopback, which breaks tests that start a local server and call it (the CLI row's tests do).
// Bring lo up first (SIOCSIFFLAGS via python3: no `ip` on this host). The host's own loopback stays unreachable.
const LO_UP = `import socket,fcntl,struct; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); fcntl.ioctl(s.fileno(),0x8914,struct.pack("16sH14s",b"lo",0x1|0x40,b"\\0"*14))`;

const SCRIPT = `
set -e
python3 -c '${LO_UP}'
R="$BT_NEWROOT"
mount -t tmpfs tmpfs "$R"
for d in /usr /bin /sbin /lib /lib32 /lib64 /etc; do
  if [ -L "$d" ]; then ln -s "$(readlink "$d")" "$R$d"
  elif [ -d "$d" ]; then mkdir -p "$R$d"; mount --rbind "$d" "$R$d"
  fi
done
mkdir -p "$R/tmp" "$R/home/bt" "$R/dev" "$R/proc"
mount -t tmpfs tmpfs "$R/tmp"
mount -t tmpfs tmpfs "$R/home/bt"
mount --rbind /dev "$R/dev"
mount -t proc proc "$R/proc"
for pair in $BT_RO; do
  dst="\${pair%%=*}"; src="\${pair#*=}"
  mkdir -p "$R$dst"; mount --rbind "$src" "$R$dst"; mount -o remount,bind,ro "$R$dst" 2>/dev/null || true
done
for p in $BT_RW; do mkdir -p "$R$p"; mount --rbind "$p" "$R$p"; done
exec chroot "$R" /bin/sh -c 'cd "$1" && shift && exec "$@"' sh "$BT_CWD" "$@"
`;

const INNER_PATH = '/usr/local/bin:/usr/bin:/bin';

/** Run `cmd args` inside the box with a scrubbed env (extra vars must name paths that are bound rw). */
export async function boxExec(cmd: string, args: string[], box: Box, opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ExecResult> {
  for (const p of [...box.rw, ...box.ro]) if (/\s/.test(p)) throw new SandboxUnavailable(`path with whitespace cannot be bound: ${p}`);
  const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-boxroot-'));
  const inner = ['env', '-i', `PATH=${INNER_PATH}`, 'HOME=/home/bt', 'TMPDIR=/tmp', 'LANG=C.UTF-8', 'NO_COLOR=1', ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`), cmd, ...args];
  try {
    return await exec('unshare', ['--user', '--map-root-user', '--net', '--mount', '--pid', '--fork', '--kill-child', 'sh', '-c', SCRIPT, 'sh', ...inner], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? INNER_PATH, BT_NEWROOT: newRoot, BT_CWD: box.cwd, BT_RW: box.rw.join(' '), BT_RO: box.ro.join(' ') },
      timeoutMs: opts.timeoutMs,
    });
  } finally {
    fs.rmSync(newRoot, { recursive: true, force: true });
  }
}

let probeCache: Promise<{ ok: boolean; detail: string }> | null = null;

/**
 * Prove the sandbox works on this host: inside it, a file outside the root must be invisible, a connect to a live local
 * listener must fail, and the rw root must be writable. Cached per process.
 */
export function probeSandbox(): Promise<{ ok: boolean; detail: string }> {
  probeCache ??= doProbe();
  return probeCache;
}

async function doProbe(): Promise<{ ok: boolean; detail: string }> {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-probe-outside-'));
  const canary = path.join(outside, 'canary.txt');
  fs.writeFileSync(canary, 'SECRET');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-probe-root-'));
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  try {
    // Inside: loopback must work (own server reachable), the host's listener must not be, the canary must be invisible,
    // and the rw root must be writable.
    const js = `const fs=require('fs'),net=require('net');let f=false;try{fs.readFileSync(process.argv[1]);f=true}catch{}
let w=false;try{fs.writeFileSync(process.argv[3]+'/w.txt','x');w=true}catch{}
const own=net.createServer(c=>c.destroy());
own.listen(0,'127.0.0.1',()=>{
  const lo=net.connect(own.address().port,'127.0.0.1');
  lo.on('error',()=>{console.log('NO-LOOPBACK');process.exit(0)});
  lo.on('connect',()=>{
    const s=net.connect(+process.argv[2],'127.0.0.1');
    s.on('connect',()=>{console.log('LEAK-NET');process.exit(0)});
    s.on('error',()=>{console.log(f?'LEAK-FILE':!w?'NO-WRITE':'SANDBOXED');process.exit(0)});
  });
});`;
    const r = await boxExec('node', ['-e', js, canary, String(port), root], { cwd: root, rw: [root], ro: [] }, { timeoutMs: 60_000 });
    const out = r.stdout.trim();
    if (r.code === 0 && out === 'SANDBOXED') return { ok: true, detail: 'unshare user+mount+pid+net namespaces with a chroot root' };
    return { ok: false, detail: out && out !== '' ? `isolation check failed: ${out}` : `unshare could not set up the sandbox (exit ${r.code}): ${r.stderr.trim().slice(-200)}` };
  } finally {
    server.close();
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Throws SandboxUnavailable with the reason unless the probe passes. Call before running any agent-written code. */
export async function requireSandbox(): Promise<string> {
  const p = await probeSandbox();
  if (!p.ok) throw new SandboxUnavailable(`refusing to run agent-written code: no usable sandbox on this host (${p.detail})`);
  return p.detail;
}
