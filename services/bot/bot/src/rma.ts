// The bot's sessions in the shape of the Run My Agents board API, so the real board page (rma.generated.ts, copied from
// run-my-agents by scripts/sync-rma.ts) can draw them: one job or chat is one agent card with a face, a feed and a state.
import { TERMINAL, type Checkpoint, type Step } from './jobs';
import { FACES } from './rma.generated';

// Which Run My Agents face stands for what the bot is doing.
const ROLE: Record<string, string> = { 'readme-score': 'Chores', 'ai-findable': 'SEO', chat: 'Calls' };
const DOING: Record<Step, string> = {
  claiming: 'Claiming the job',
  claimed: 'Doing the work',
  worked: 'Submitting the result',
  submitted: 'Waiting for the poster',
  accepted: 'Accepted by the poster',
  rejected: 'Rejected by the poster',
  failed: 'Gave the job back',
  lost: 'Lost the job',
};
const WORKING: Step[] = ['claiming', 'claimed', 'worked'];

export interface Row {
  sessionId: string;
  lastActivity: string;
  c: Checkpoint;
  active: boolean;
}

export function boardSession(r: Row, board: string) {
  const { c } = r;
  const j = c.job;
  const role = ROLE[j ? j.kind : 'chat'] ?? 'Code';
  const at = (s: string) => Date.parse(s) || Date.now();
  const feed = c.messages.map((m) => ({
    who: m.role === 'user' ? 'you' : 'agent',
    text: m.content,
    tools: m.event ? [m.event] : [],
    at: at(m.at),
    t0: at(m.at),
  }));
  const last = c.messages.at(-1);
  const sending = r.active || (!!j && WORKING.includes(j.step));
  return {
    id: r.sessionId,
    agent: 'claude',
    // The bot uses no model: its work is Flisk's own tools, so the same input always gives the same answer.
    model: 'no model',
    tokens: { used: 0, cached: 0 },
    cwd: j ? j.boardUrl : board,
    branch: j ? j.step : 'chat',
    branches: [],
    title: c.title || j?.title || (c.messages.find((m) => m.role === 'user')?.content.slice(0, 60) ?? 'New session'),
    said: last?.role === 'agent' ? last.content.slice(0, 200) : '',
    doing: j ? DOING[j.step] : sending ? 'Checking' : '',
    edits: [],
    role,
    roleSet: true,
    pinned: false,
    awaiting: false,
    viaApp: false,
    face: FACES[role] ?? FACES.Code,
    lower: null,
    skills: [],
    sending,
    prs: j?.result
      ? [{ number: 0, title: j.result.summary, state: j.step === 'accepted' ? 'MERGED' : 'OPEN', url: j.result.url, repo: new URL(board).host, branch: j.step, draft: false, checks: TERMINAL.includes(j.step) && j.step !== 'accepted' ? 'failure' : 'success', review: j.step === 'accepted' ? 'APPROVED' : 'REVIEW_REQUIRED', merge: j.step === 'accepted' ? 'MERGED' : 'BLOCKED' }]
      : [],
    queue: [],
    updatedAt: at(r.lastActivity),
    feed,
  };
}

/** The answer to the board's GET api/sessions. */
export function boardSessions(rows: Row[], board: string) {
  return { sessions: rows.map((r) => boardSession(r, board)), clashes: [], limits: { sessionTokens: 0, autoDowngrade: false }, order: [], build: 'bot' };
}

/** The answer to the board's GET api/options, which its new-session form reads. */
export function boardOptions() {
  return {
    agents: { claude: true, codex: false, grok: false },
    defaultAgent: 'claude',
    folders: [],
    roles: Object.entries(FACES).map(([role, f]) => ({ role, color: f.color, shape: f.shape, eyes: f.eyes })),
  };
}
