// bot.flisk.si: the bot's durable sessions, drawn like the Run My Agents app (sidebar of sessions with faces, one
// conversation on the right). It reads the same checkpoints `flisk agent sessions bot` reads.
import { AGENTS, avatar } from './avatars';
import { TERMINAL, type Checkpoint } from './jobs';

const face = (role: string) => AGENTS.find((a) => a.role === role) ?? AGENTS[0];
const FACES = {
  'readme-score': avatar(face('Planner'), 40),
  'ai-findable': avatar(face('SEO'), 40),
  chat: avatar(face('Calls'), 40),
  bot: avatar(face('Feature'), 40),
};

export function overview(rows: { sessionId: string; lastActivity: string; checkpointBytes: number; status: 'active' | 'idle'; c: Checkpoint; active: boolean }[], meta: { name: string; board: string; loop: unknown }) {
  const sessions = rows.map(({ sessionId, lastActivity, checkpointBytes, status, c, active }) => {
    const j = c.job;
    const last = c.messages.at(-1);
    return {
      id: sessionId,
      title: c.title || j?.title || (c.messages.find((m) => m.role === 'user')?.content.slice(0, 60) ?? 'New session'),
      kind: j ? j.kind : 'chat',
      step: j ? j.step : null,
      done: j ? TERMINAL.includes(j.step) : false,
      active,
      at: lastActivity,
      status,
      bytes: checkpointBytes,
      last: last ? last.content.split('\n')[0].slice(0, 90) : '',
      board: j ? `${meta.board}/job/${j.id}` : null,
    };
  });
  const count = (f: (s: (typeof sessions)[number]) => boolean) => sessions.filter(f).length;
  return {
    ...meta,
    faces: FACES,
    totals: { sessions: sessions.length, jobs: count((s) => s.kind !== 'chat'), accepted: count((s) => s.step === 'accepted'), working: count((s) => s.kind !== 'chat' && !s.done) },
    sessions,
  };
}

export function page(name: string, base = ''): string {
  const b = base.replace(/[^A-Za-z0-9/_-]/g, '').replace(/\/+$/, '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title><meta name="description" content="A bot that takes jobs from the open jobs board. Every job is a durable session you can read.">
<style>
:root{color-scheme:dark;--text:#ececf1;--muted:rgba(236,236,241,.55);--line:rgba(255,255,255,.07);--green:#22c55e;--mint:#6ee7a0;--amber:#f59e0b;--red:#f87171;
--body:system-ui,-apple-system,"Segoe UI",sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:#06060a;color:var(--text);font:13px/1.5 var(--body);-webkit-font-smoothing:antialiased;padding:8px}
a{color:inherit}button{font:inherit;color:inherit}
.app{height:100%;display:grid;grid-template-columns:minmax(280px,30%) minmax(0,1fr);gap:8px;padding:8px;border-radius:22px;background:linear-gradient(120deg,#0b0b12,#10101a,#0c1210,#0b0b12);background-size:300% 300%;animation:bg 14s ease infinite;box-shadow:inset 0 0 0 1px var(--line)}
@keyframes bg{50%{background-position:100% 50%}}@media (prefers-reduced-motion:reduce){.app{animation:none}}
.side,.main{border-radius:14px;background:rgba(18,18,26,.75);box-shadow:inset 0 0 0 1px var(--line);overflow:auto}
.side{padding:12px}.main{display:flex;flex-direction:column;min-width:0}
.top{display:flex;align-items:center;gap:8px;margin:2px 4px 12px}.top b{font-size:14px;flex:1}.top b span{color:var(--mint)}
.pillc{font:500 11px var(--mono);padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);white-space:nowrap}
.pillc i{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:6px;vertical-align:1px}
.pillc.off i{background:var(--red)}
.new{display:inline-flex;gap:6px;align-items:center;padding:7px 14px;border-radius:999px;border:0;background:var(--green);color:#04120a;font-weight:600;cursor:pointer;box-shadow:0 0 0 1px rgba(255,255,255,.12) inset,0 6px 20px rgba(34,197,94,.25)}
.new:hover{filter:brightness(1.08)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:12px 0}
.st{padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px var(--line)}.st b{display:block;font-size:18px}.st span{font:10.5px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.grp{font:500 11px var(--mono);color:var(--muted);margin:14px 6px 6px;text-transform:uppercase;letter-spacing:.06em}
.row{display:grid;grid-template-columns:44px minmax(0,1fr);gap:10px;padding:9px 10px;border-radius:10px;cursor:pointer;border:0;background:none;width:100%;text-align:left}
.row:hover{background:rgba(255,255,255,.04)}.row[aria-current=true]{background:rgba(110,231,160,.08);box-shadow:inset 0 0 0 1px rgba(110,231,160,.25)}
.row .fx{position:relative;width:40px;height:40px}.row .fx .dot{position:absolute;right:-2px;bottom:2px;width:10px;height:10px;border-radius:50%;background:#555;box-shadow:0 0 0 2px #12121a}
.dot.active{background:var(--green);animation:pulse 1.2s ease infinite}.dot.accepted{background:var(--mint)}.dot.rejected,.dot.failed,.dot.lost{background:var(--red)}.dot.submitted,.dot.claimed,.dot.claiming,.dot.worked{background:var(--amber)}
@keyframes pulse{50%{opacity:.4}}
.row .tt{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row .tt::first-letter{color:var(--mint)}
.tags{display:flex;gap:5px;margin:3px 0 2px;flex-wrap:wrap}.tag{font:500 10px var(--mono);padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.06);color:var(--muted);text-transform:uppercase}
.tag.k{background:rgba(34,197,94,.14);color:var(--mint)}.tag.s{background:rgba(245,158,11,.14);color:var(--amber)}.tag.ok{background:rgba(110,231,160,.16);color:var(--mint)}.tag.bad{background:rgba(248,113,113,.14);color:var(--red)}
.row .ls{color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)}
.head h1{font-size:15px;margin:0;font-weight:600}.head h1 span{color:var(--muted);font-weight:400}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.chip{font:11.5px var(--mono);padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);text-decoration:none}
a.chip:hover{color:var(--text)}
.msgs{flex:1;overflow:auto;padding:18px;display:flex;flex-direction:column;gap:12px}
.b{max-width:min(620px,85%);padding:10px 14px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;line-height:1.55;font-size:13.5px}
.b .who{display:block;font:500 10.5px var(--mono);letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
.b.user{align-self:flex-end;background:rgba(34,197,94,.13);box-shadow:inset 0 0 0 1px rgba(34,197,94,.3)}
.b.agent{align-self:flex-start;background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px var(--line)}
.b a{color:var(--mint)}
.ev{align-self:flex-start;display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;font-size:13px;max-width:min(680px,92%)}
.ev .k{font:600 10.5px var(--mono);text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.06);color:var(--muted);height:fit-content;margin-top:2px}
.ev .k.accepted,.ev .k.worked{background:rgba(110,231,160,.14);color:var(--mint)}.ev .k.rejected,.ev .k.failed,.ev .k.lost{background:rgba(248,113,113,.14);color:var(--red)}.ev .k.retry{background:rgba(245,158,11,.14);color:var(--amber)}
.ev .x{white-space:pre-wrap;word-wrap:break-word}.ev .x a{color:var(--mint)}.ev time{display:block;font:10.5px var(--mono);color:var(--muted)}
.comp{display:flex;gap:8px;align-items:center;margin:10px;padding:8px 8px 8px 14px;border-radius:14px;background:rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px var(--line)}
.comp input{flex:1;background:none;border:0;color:var(--text);font:14px var(--body);outline:none;min-width:0}
.comp button{padding:7px 16px;border-radius:10px;border:0;background:var(--green);color:#04120a;font-weight:600;cursor:pointer}.comp button:disabled{opacity:.5;cursor:default}
.empty{color:var(--muted);padding:30px 18px;line-height:1.7}.empty b{color:var(--text)}
.honest{margin:10px 4px 0;padding:10px 12px;border-radius:10px;font-size:12px;color:var(--muted);background:rgba(245,158,11,.06);box-shadow:inset 0 0 0 1px rgba(245,158,11,.2)}
.back{display:none}
@media (max-width:760px){.app{grid-template-columns:minmax(0,1fr)}.app.open .side{display:none}.app:not(.open) .main{display:none}.back{display:inline-block;border:0;background:rgba(255,255,255,.06);border-radius:8px;padding:4px 10px;cursor:pointer}body{padding:0}.app{border-radius:0}}
</style></head><body>
<div class="app" id="app">
<aside class="side" aria-label="Sessions">
  <div class="top"><b>${name.replace(/^(\S+)/, '<span>$1</span>')}</b><span class="pillc" id="loop"><i></i>…</span></div>
  <button class="new" id="new">+ New session</button>
  <div class="stats" id="stats"></div>
  <div id="list"></div>
  <div class="honest">Payment is not live. The bot takes jobs for the record, not for money. Every job links to its public timeline on the board.</div>
</aside>
<main class="main" id="main"><div class="empty" id="intro"><b>Pick a session.</b><br>Each job the bot takes from the board is one durable session, saved after every step, so a restart picks up where it stopped. You can also start a new session and ask it to check a GitHub repo or a web page.</div></main>
</div>
<script>
(() => {
  const B = ${JSON.stringify(b)};
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const linkify = (s) => esc(s).replace(/https?:\\/\\/[^\\s<]+/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener nofollow">' + u + '</a>');
  const ago = (iso) => { const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000); return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.round(s / 60) + ' min' : s < 86400 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' d'; };
  const bytes = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  let data = null, current = new URLSearchParams(location.hash.slice(1)).get('s'), sending = false, drawnFor = null, drawnLen = -1;

  const stepTag = (s) => !s.step ? '<span class="tag">chat</span>' : '<span class="tag ' + (s.step === 'accepted' ? 'ok' : ['rejected', 'failed', 'lost'].includes(s.step) ? 'bad' : 's') + '">' + esc(s.step) + '</span>';
  function side() {
    const t = data.totals;
    $('#stats').innerHTML = [['Jobs', t.jobs], ['Working', t.working], ['Accepted', t.accepted]].map(([l, n]) => '<div class="st"><b>' + n + '</b><span>' + l + '</span></div>').join('');
    const l = data.loop;
    $('#loop').className = 'pillc' + (l.enabled && !l.lastError ? '' : ' off');
    $('#loop').innerHTML = '<i></i>' + (!l.enabled ? 'chat only' : l.lastError ? 'board unreachable' : 'taking jobs');
    $('#loop').title = l.lastError || (l.lastPass ? 'last look at the board ' + ago(l.lastPass) + ' ago' : '');
    const groups = [['Working', data.sessions.filter((s) => s.kind !== 'chat' && !s.done)], ['Finished jobs', data.sessions.filter((s) => s.kind !== 'chat' && s.done)], ['Chats', data.sessions.filter((s) => s.kind === 'chat')]];
    $('#list').innerHTML = groups.filter(([, g]) => g.length).map(([n, g]) => '<div class="grp">▾ ' + n + ' · ' + g.length + '</div>' + g.map((s) =>
      '<button class="row" data-s="' + esc(s.id) + '" aria-current="' + (s.id === current) + '"><span class="fx">' + (data.faces[s.kind] || data.faces.chat) + '<span class="dot ' + (s.active ? 'active' : esc(s.step || '')) + '"></span></span>' +
      '<span style="min-width:0"><div class="tt">' + esc(s.title) + '</div><div class="tags">' + (s.kind !== 'chat' ? '<span class="tag k">' + esc(s.kind) + '</span>' : '') + stepTag(s) + '<span class="tag">' + ago(s.at) + '</span></div><div class="ls">' + esc(s.last) + '</div></span></button>').join('')).join('') ||
      '<div class="empty">No sessions yet. ' + (data.loop.enabled ? 'The bot looks at the board every few seconds and starts one per job.' : '') + '</div>';
  }

  async function show(id, force) {
    current = id;
    history.replaceState(null, '', '#s=' + encodeURIComponent(id));
    $('#app').classList.add('open');
    const c = await fetch(B + '/session?id=' + encodeURIComponent(id), { cache: 'no-store' }).then((r) => r.json());
    if (!force && drawnFor === id && drawnLen === c.messages.length) return;
    const s = data?.sessions.find((x) => x.id === id);
    const j = c.job;
    const keep = drawnFor === id ? $('#msg')?.value : '';
    $('#main').innerHTML = '<div class="head"><button class="back" id="back">‹</button><span style="width:40px;height:40px">' + (data.faces[j ? j.kind : 'chat']) + '</span><div style="min-width:0"><h1>' + (j ? esc(j.kind) + ' <span>· ' + esc(c.title || j.title) + '</span>' : esc(c.title || 'New session')) + '</h1>' +
      '<div class="chips"><span class="chip"># ' + esc(id) + '</span>' + (j ? '<span class="chip">step: ' + esc(j.step) + '</span><a class="chip" href="' + esc(s?.board || '#') + '" target="_blank" rel="noopener">public record ↗</a>' + (j.result ? '<a class="chip" href="' + esc(j.result.url) + '" target="_blank" rel="noopener nofollow">result ↗</a>' : '') : '<span class="chip">chat</span>') + '<span class="chip">' + c.messages.length + ' saved messages</span><span class="chip">' + (s ? esc(s.status) + ' · ' + bytes(s.bytes) + ' · last activity ' + ago(s.at) + ' ago' : esc(c.status || 'idle')) + '</span></div></div></div>' +
      '<div class="msgs" id="msgs">' + (c.messages.map((m) => m.event
        ? '<div class="ev"><span class="k ' + esc(m.event) + '">' + esc(m.event) + '</span><div class="x">' + linkify(m.content) + '<time>' + clock(m.at) + '</time></div></div>'
        : '<div class="b ' + (m.role === 'user' ? 'user' : 'agent') + '"><span class="who">' + (m.role === 'user' ? 'YOU' : 'BOT') + ' ' + clock(m.at) + '</span>' + linkify(m.content) + '</div>').join('') ||
        '<div class="empty">Send a GitHub repo like <b>flisk-sh/pages</b> or a page like <b>https://pages.flisk.si</b> and the bot checks it now.</div>') + '</div>' +
      '<form class="comp" id="comp"><input id="msg" autocomplete="off" maxlength="2000" placeholder="' + (j ? 'Ask where this job stands…' : 'A GitHub repo or an https:// page…') + '"><button id="send">Send</button></form>';
    drawnFor = id; drawnLen = c.messages.length;
    $('#msg').value = keep || '';
    $('#msgs').scrollTop = 1e9;
    $('#back').onclick = () => $('#app').classList.remove('open');
    $('#comp').onsubmit = async (e) => {
      e.preventDefault();
      const input = $('#msg').value.trim();
      if (!input || sending) return;
      sending = true; $('#send').disabled = true; $('#send').textContent = 'Working…';
      $('#msgs').insertAdjacentHTML('beforeend', '<div class="b user"><span class="who">YOU now</span>' + esc(input) + '</div>');
      $('#msgs').scrollTop = 1e9; $('#msg').value = '';
      await fetch(B + '/turn', { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': id }, body: JSON.stringify({ input }) }).catch(() => {});
      sending = false;
      await refresh(); await show(id, true);
    };
    if (data) side();
  }

  async function refresh() {
    try {
      const r = await fetch(B + '/api/overview', { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
      side();
    } catch {
      // The bot is restarting or the stack is down: say so, keep the last view, try again on the next tick.
      $('#loop').className = 'pillc off';
      $('#loop').innerHTML = '<i></i>bot offline';
    }
  }
  document.addEventListener('click', (e) => { const r = e.target.closest('[data-s]'); if (r) show(r.dataset.s, true); });
  $('#new').onclick = () => show('chat-' + Math.random().toString(36).slice(2, 8), true);
  refresh().then(() => { if (current) show(current, true); });
  setInterval(async () => { if (document.hidden || sending) return; await refresh(); if (current && $('#msgs')) show(current, false).catch(() => {}); }, 3000);
})();
</script></body></html>`;
}
