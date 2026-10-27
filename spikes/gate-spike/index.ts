/**
 * THROWAWAY spike for docs/REAL-GATE-IMPL-PLAN.md (S1-S5). Never part of the ten workers, CI or typecheck (outside workers/).
 * Bearer-protected (SPIKE_TOKEN, fail closed). No arbitrary command endpoint: every route runs a fixed script.
 *   POST /run     {action:'measure', size, repo, commitSha}   clone, `npm ci --ignore-scripts` (registry intercept), swap to deny, `npm test`: S1, S2
 *   POST /run     {action:'egress', size}                     probe egress with the registry intercept, then after the deny swap: S4
 *   POST /run     {action:'hold', size, seconds}              one long call: S5 (HTTP path)
 *   POST /enqueue {seconds}                                   S5 (queue consumer path); GET /status?name=hold-q
 *   POST /flood   {n}                                         S3: start n DO containers at once (lite) and report which failed
 */
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { createRepoToken } from '../../workers/shared/artifacts';
import { isValidNamespace } from '../../workers/shared/namespace';
export { ArtifactsGateway } from '../../workers/sandbox-runner/build-sandbox';

interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
  ARTIFACTS_NAMESPACE: string;
  SPIKE_TOKEN?: string;
  SPIKE: DurableObjectNamespace<SpikeSandbox>;
  SPIKE_Q: Queue<{ seconds: number }>;
}

const SIZES = ['lite', 'standard-1', 'standard-2'] as const;
type Size = (typeof SIZES)[number];
const CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const REGISTRY = 'registry.npmjs.org';
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TAIL = 3000;

type Step = { name: string; exitCode: number; ms: number; out: string };
type RunArgs = { action: 'measure' | 'egress' | 'hold'; size: Size; repo?: string; commitSha?: string; seconds?: number };

/** GET-only pass-through to the npm registry, or (props.deny) a 403 for everything: the "deny" replacement handler. */
export class RegistryGateway extends WorkerEntrypoint<unknown, { deny?: boolean }> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (this.ctx.props?.deny || request.method !== 'GET' || url.hostname !== REGISTRY) return new Response('denied', { status: 403 });
    const res = await fetch(new Request(request, { headers: { accept: request.headers.get('accept') ?? '*/*' }, redirect: 'manual' }));
    return res.status >= 300 && res.status < 400 ? new Response('redirect refused', { status: 502 }) : res;
  }
}

const EGRESS_JS = `
const t = [['https-registry','https://registry.npmjs.org/-/ping'],['http-example','http://example.com/'],['https-example','https://example.com/'],['https-ip','https://1.1.1.1/']];
for (const [n,u] of t) { try { const r = await fetch(u,{signal:AbortSignal.timeout(8000)}); console.log(n, r.status); } catch (e) { console.log(n, 'ERR', e.cause?.code ?? e.message); } }
const dns = await import('node:dns/promises'); try { console.log('dns', JSON.stringify(await dns.lookup('example.com'))); } catch (e) { console.log('dns ERR', e.code); }
const net = await import('node:net'); await new Promise((ok) => { const s = net.connect({host:'1.1.1.1',port:443,timeout:5000}, () => { console.log('tcp-1.1.1.1:443 CONNECTED'); s.destroy(); ok(); }); s.on('error', (e) => { console.log('tcp ERR', e.code); ok(); }); s.on('timeout', () => { console.log('tcp TIMEOUT'); s.destroy(); ok(); }); });
`;

export class SpikeSandbox extends DurableObject<Env> {
  private async sh(script: string, env: Record<string, string> = {}): Promise<Step> {
    const t0 = Date.now();
    const proc = await this.ctx.container!.exec(['sh', '-c', script], { cwd: '/tmp', env: { HOME: '/tmp', NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, GIT_TERMINAL_PROMPT: '0', ...env } });
    const out = await proc.output();
    const dec = new TextDecoder();
    return { name: script.slice(0, 60), exitCode: out.exitCode, ms: Date.now() - t0, out: (dec.decode(out.stdout) + dec.decode(out.stderr)).slice(-TAIL) };
  }

  private intercepts(gateway: Fetcher, artifacts: Fetcher | null) {
    const c = this.ctx.container!;
    return Promise.all([c.interceptOutboundHttps(REGISTRY, gateway), c.interceptOutboundHttps(`${this.env.CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net`, artifacts ?? gateway)]);
  }

  async run(a: RunArgs): Promise<{ size: string; steps: Step[]; error?: string }> {
    const c = this.ctx.container!;
    const steps: Step[] = [];
    try {
      if (!c.running) c.start({ image: c.images.spike, instance: a.size, enableInternet: false, entrypoint: ['sleep', 'infinity'] });
      const exp = this.ctx.exports as unknown as { RegistryGateway: (o: { props: { deny?: boolean } }) => Fetcher; ArtifactsGateway: (o: { props: unknown }) => Fetcher };
      const allow = exp.RegistryGateway({ props: {} });
      const deny = exp.RegistryGateway({ props: { deny: true } });
      const ns = this.env.ARTIFACTS_NAMESPACE;
      steps.push(await this.sh('node --version; npm --version; git --version; nproc; free -m | head -2; df -m /tmp | tail -1; cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max 2>&1'));
      if (a.action === 'hold') {
        steps.push(await this.sh(`sleep ${Math.min(Math.max(a.seconds ?? 10, 1), 600)}`));
        await this.ctx.storage.put('last', { at: Date.now(), size: a.size, steps });
      } else if (a.action === 'egress') {
        await this.intercepts(allow, null);
        await this.ctx.storage.put('x', 1); // keep the DO warm
        steps.push({ ...(await this.sh(`cat > /tmp/egress.mjs <<'EOF'\n${EGRESS_JS}\nEOF\nnode /tmp/egress.mjs`)), name: 'egress WITH registry intercept (control: only https-registry may succeed)' });
        await this.intercepts(deny, null);
        steps.push({ ...(await this.sh('node /tmp/egress.mjs')), name: 'egress AFTER deny swap (nothing may succeed)' });
      } else {
        const { repo, commitSha } = a;
        if (!repo || !REPO_RE.test(repo) || !commitSha || !SHA_RE.test(commitSha) || !isValidNamespace(ns) || !this.env.CLOUDFLARE_API_TOKEN) throw new Error('bad measure request or missing secret');
        const token = (await createRepoToken({ accountId: this.env.CLOUDFLARE_ACCOUNT_ID, apiToken: this.env.CLOUDFLARE_API_TOKEN, namespace: ns }, repo, 'read', 240)).token;
        await this.intercepts(allow, exp.ArtifactsGateway({ props: { repo, namespace: ns, token } }));
        const url = `https://${this.env.CLOUDFLARE_ACCOUNT_ID}.artifacts.cloudflare.net/git/${ns}/${repo}.git`;
        const g = 'git -c core.hooksPath=/dev/null -c core.symlinks=false';
        steps.push(await this.sh(`rm -rf /tmp/cand && ${g} clone --quiet --no-checkout ${url} /tmp/cand && ${g} -C /tmp/cand checkout --quiet ${commitSha} && ls /tmp/cand | head -20`, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }));
        const peak = 'echo peak_mem_bytes=$(cat /sys/fs/cgroup/memory.peak 2>/dev/null); du -sm /tmp/cand | cut -f1 | sed "s/^/disk_mb=/"';
        const cfg = { NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null', NPM_CONFIG_CACHE: '/tmp/npm-cache', CI: '1' };
        steps.push({ ...(await this.sh(`cd /tmp/cand && rm -f .npmrc && npm ci --ignore-scripts --no-audit --no-fund --registry https://${REGISTRY}/ > /tmp/ci.log 2>&1; echo exit=$?; tail -n 15 /tmp/ci.log; ${peak}`, cfg)), name: 'npm ci (registry intercept on)' });
        await this.intercepts(deny, deny);
        steps.push({ ...(await this.sh(`cd /tmp/cand && npm test > /tmp/test.log 2>&1; echo exit=$?; tail -n 25 /tmp/test.log; ${peak}`, cfg)), name: 'npm test (all intercepts denied)' });
      }
    } catch (e) {
      return { size: a.size, steps, error: e instanceof Error ? e.message : String(e) };
    } finally {
      try { if (c.running) await c.destroy('spike finished'); } catch { /* the container also stops on inactivity */ }
    }
    return { size: a.size, steps };
  }

  async status(): Promise<unknown> { return (await this.ctx.storage.get('last')) ?? null; }
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.SPIKE_TOKEN) return json({ error: 'not configured' }, 503);
    if (request.headers.get('Authorization') !== `Bearer ${env.SPIKE_TOKEN}`) return json({ error: 'unauthorized' }, 401);
    const url = new URL(request.url);
    if (url.pathname === '/status') return json(await env.SPIKE.getByName(url.searchParams.get('name') ?? 'hold-q').status());
    if (request.method !== 'POST') return json({ error: 'not found' }, 404);
    const body = (await request.json().catch(() => ({}))) as Partial<RunArgs> & { n?: number };
    if (url.pathname === '/enqueue') { await env.SPIKE_Q.send({ seconds: Math.min(body.seconds ?? 590, 600) }); return json({ queued: true }); }
    if (url.pathname === '/flood') {
      const n = Math.min(Math.max(body.n ?? 5, 1), 30);
      const t0 = Date.now();
      const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => env.SPIKE.getByName(`flood-${i}`).run({ action: 'hold', size: 'lite', seconds: 30 })));
      return json({ n, ms: Date.now() - t0, results: results.map((r, i) => (r.status === 'fulfilled' ? { i, ok: !r.value.error, error: r.value.error, firstStepMs: r.value.steps[0]?.ms } : { i, ok: false, error: String(r.reason) })) });
    }
    if (url.pathname === '/run' && body.size && (SIZES as readonly string[]).includes(body.size) && body.action) {
      return json(await env.SPIKE.getByName(`run-${body.action}-${body.size}-${Date.now()}`).run(body as RunArgs));
    }
    return json({ error: 'bad request' }, 400);
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const m of batch.messages) await env.SPIKE.getByName('hold-q').run({ action: 'hold', size: 'lite', seconds: (m.body as { seconds: number }).seconds });
  },
} satisfies ExportedHandler<Env>;
