/**
 * LOCAL E2E ONLY probe worker (see wrangler.toml). Holds SPEC_DO_INTERNAL_TOKEN and never
 * SPEC_DO_ADMIN_TOKEN, like every non-API worker. POST /forward relays one request to the Spec DO:
 *   { method, path, body?, token?: 'tier1' (default) | 'none' | 'wrong' }
 * and answers { status, body } from the DO.
 */
import { authGate, jsonError, type AuthEnv } from '../../../workers/shared/auth';
import { INTERNAL_TOKEN_HEADER, getSpecDoStub, type SpecDoCallerEnv } from '../../../workers/shared/spec-do-auth';

interface ProbeEnv extends AuthEnv, SpecDoCallerEnv {
  BEEHIVE_LOCAL_DEV?: string;
}

interface ForwardRequest {
  method?: string;
  path?: string;
  body?: unknown;
  actorId?: string;
  token?: 'tier1' | 'none' | 'wrong';
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (env.BEEHIVE_LOCAL_DEV !== '1') return new Response('Not found', { status: 404 });
    const denied = await authGate(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('OK');
    if (url.pathname !== '/forward' || request.method !== 'POST') return jsonError('Not found', 404);

    const req = (await request.json().catch(() => ({}))) as ForwardRequest;
    if (!req.path || !req.path.startsWith('/')) return jsonError('path required', 400);
    const init: RequestInit = {
      method: req.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...(req.actorId ? { 'X-Actor-ID': req.actorId } : {}) },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    };

    let response: Response;
    if (req.token === 'none' || req.token === 'wrong') {
      // Deliberately bypasses the authed stub
      const stub = env.SPEC_DO.get(env.SPEC_DO.idFromName('main'));
      const headers = new Headers(init.headers);
      if (req.token === 'wrong') headers.set(INTERNAL_TOKEN_HEADER, 'not-the-token');
      response = await stub.fetch(new Request(`https://spec-do.internal${req.path}`, { ...init, headers }));
    } else {
      response = await getSpecDoStub(env).fetch(req.path, init);
    }
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON (e.g. /health answers OK)
    }
    return Response.json({ status: response.status, body });
  },
};
