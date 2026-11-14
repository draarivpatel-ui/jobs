// What the bot can actually do. Each kind calls a public Flisk tool and returns a result link the jobs board can
// open itself. No model and no guessing: the same input gives the same answer, so a failed job is never a bluff.

export interface WorkResult {
  url: string;
  score: number;
  grade: string;
  summary: string;
  fixes: string[];
}

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<any> {
  const res = await f(url, { headers: { accept: 'application/json', 'user-agent': 'flisk-bot (jobs)' }, signal: AbortSignal.timeout(45_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ? `${body.error} (HTTP ${res.status})` : `HTTP ${res.status}`);
  return body;
}

export async function readmeScore(repo: string, f: Fetch = fetch): Promise<WorkResult> {
  const r = await getJson(f, `https://readme.flisk.si/api/score?repo=${encodeURIComponent(repo)}`);
  if (typeof r.score !== 'number' || typeof r.url !== 'string') throw new Error('README Score answered without a score');
  const misses = (r.groups ?? []).flatMap((g: any) => (g.checks ?? []).filter((c: any) => !c.pass && c.fix)).slice(0, 3);
  return {
    url: r.url,
    score: r.score,
    grade: String(r.grade ?? ''),
    summary: `README of ${repo}: ${r.score}/100 (grade ${r.grade}).`,
    fixes: misses.map((c: any) => `${c.title}: ${String(c.fix).split('. ')[0]}.`),
  };
}

export async function aiFindable(url: string, f: Fetch = fetch): Promise<WorkResult> {
  const r = await getJson(f, `https://citable.flisk.si/api/check?url=${encodeURIComponent(url)}`);
  if (typeof r.score !== 'number') throw new Error('Citable answered without a score');
  // "info" lines are choices, not problems (Citable says so itself), so only failures and warnings become fixes.
  const misses = (r.checks ?? []).filter((c: any) => c.status === 'fail' || c.status === 'warn').slice(0, 3);
  return {
    url: `https://citable.flisk.si/check?url=${encodeURIComponent(url)}`,
    score: r.score,
    grade: String(r.grade ?? ''),
    summary: `${r.host ?? url}: ${r.score}/100 for AI search (grade ${r.grade}).`,
    fixes: misses.map((c: any) => `${c.title}: ${c.summary ?? c.status}`),
  };
}

export const KINDS = ['readme-score', 'ai-findable'] as const;
export type Kind = (typeof KINDS)[number];

export function doWork(kind: Kind, input: Record<string, string>, f: Fetch = fetch): Promise<WorkResult> {
  return kind === 'readme-score' ? readmeScore(input.repo, f) : aiFindable(input.url, f);
}

/** Reads a chat message for something the bot can check right away: a GitHub repo or a web address. */
export function parseAsk(text: string): { kind: Kind; input: Record<string, string> } | null {
  const gh = /(?:github\.com\/)?\b([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\b/.exec(text.replace(/https?:\/\/(?!github\.com)[^\s]+/g, ''));
  if (/github\.com\//.test(text) || (gh && !/https?:\/\//.test(text) && /readme|repo|score|^\s*[\w-]+\/[\w.-]+\s*$/i.test(text))) {
    const m = /github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})/.exec(text)?.[1] ?? gh?.[1];
    if (m) return { kind: 'readme-score', input: { repo: m.replace(/\.git$/, '').replace(/[.,;:]+$/, '') } };
  }
  const url = /https:\/\/[^\s<>"']+/.exec(text)?.[0]?.replace(/[.,;:)]+$/, '');
  if (url) return { kind: 'ai-findable', input: { url } };
  return null;
}
