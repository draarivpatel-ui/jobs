// Sends a problem to traces.flisk.si (flisk-sh/traces): only a refused (429), failed (5xx), thrown or slow request. A normal request writes nothing.
// Never throws, waits at most 2 s, does nothing until TRACE_KEY is set, sends no name, prompt, answer or key: the route is the first path part only.
export const SLOW_MS = 15_000;

export type TraceEnv = { TRACE_KEY?: string; TRACES?: { fetch: (url: string, init: RequestInit) => Promise<Response> } };
export type TraceEvent = { route: string; kind: 'error' | 'slow' | 'capped'; why: string; status?: number; ms?: number };

export async function sendTrace(env: TraceEnv, event: TraceEvent, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!env?.TRACE_KEY) return;
  try {
    const init = { method: 'POST', headers: { authorization: `Bearer ${env.TRACE_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(2000) };
    if (env.TRACES) await env.TRACES.fetch('https://traces.flisk.si/v1/trace', init);
    else await fetchImpl('https://traces.flisk.si/v1/trace', init);
  } catch { /* tracing must never break a request */ }
}

export const routeOf = (url: string): string => `/${new URL(url).pathname.split('/')[1] || ''}`;

export function problemOf(url: string, status: number, ms: number): TraceEvent | null {
  const route = routeOf(url);
  if (status === 429) return { route, kind: 'capped', why: 'a request was refused by a limit', status, ms };
  if (status >= 500) return { route, kind: 'error', why: `a request failed with ${status}`, status, ms };
  if (ms > SLOW_MS) return { route, kind: 'slow', why: `a request took ${Math.round(ms / 1000)} s`, status, ms };
  return null;
}

type Ctx = { waitUntil?: (p: Promise<unknown>) => void };
const later = async (ctx: Ctx | undefined, p: Promise<void>) => { if (ctx?.waitUntil) ctx.waitUntil(p); else await p; };

// Wraps a Worker fetch: the answer is unchanged; a problem becomes one row, sent after the answer.
export function traced<E extends TraceEnv>(fn: (req: Request, env: E, ctx?: Ctx) => Promise<Response> | Response) {
  return async (req: Request, env: E, ctx?: Ctx): Promise<Response> => {
    const started = Date.now();
    let res: Response;
    try {
      res = await fn(req, env, ctx);
    } catch (e) {
      await later(ctx, sendTrace(env, { route: routeOf(req.url), kind: 'error', why: `the Worker threw: ${String((e as Error)?.message || e).slice(0, 150)}`, ms: Date.now() - started }));
      throw e;
    }
    const p = problemOf(req.url, res.status, Date.now() - started);
    if (p) await later(ctx, sendTrace(env, p));
    return res;
  };
}
