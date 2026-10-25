// Digital Diary: interface demo.
// Same design system as the served app (public/): same tokens, same cards, same chips.
// The entries are generated samples and live in this browser only; no request leaves the page.
const CATS = [
  { id:'class',    label:'Class',    color:'#4f6ef7' },
  { id:'learning', label:'Learning', color:'#14a37f' },
  { id:'thought',  label:'Thought',  color:'#e8a33d' },
  { id:'quote',    label:'Quote',    color:'#c2578a' },
  { id:'work',     label:'Work',     color:'#64748b' },
  { id:'project',  label:'Project',  color:'#8b5cf6' },
  { id:'life',     label:'Life',     color:'#f0643c' },
  { id:'task',     label:'Task',     color:'#0ea5b7' },
  { id:'deadline', label:'Deadline', color:'#e5484d' },
  { id:'inbox',    label:'Inbox',    color:'#9ca3af' },
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const MODE_LABEL = { refined:'Refined', verbatim:'Verbatim', reason:'Reason', think:'Think' };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const STORE = 'diary-demo-v3';
const PREF = 'diary-prefs-v2';

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse = k => { const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const dim = (y, m) => new Date(y, m, 0).getDate();
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TODAY = iso(new Date());

/* The cleanup writes a small markup: blank-line paragraphs, "- " bullets, "1. " steps,
   **bold**, *italic* and ==highlight==. Escaped first, rebuilt after, so a note can never
   inject HTML. Copied from the app so the demo renders notes exactly as they are stored. */
function inlineHTML(s) {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1<em>$2</em>')
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
}
function richHTML(text) {
  const out = [];
  let list = null, para = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${inlineHTML(para.join(' '))}</p>`); para = []; } };
  for (const raw of String(text || '').split('\n')) {
    const line = esc(raw).trim();
    if (line === '') { flushPara(); closeList(); continue; }
    const bullet = /^[-*\u2022]\s+(.*)$/.exec(line);
    const step = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || step) {
      flushPara();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inlineHTML((bullet || step)[1])}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join('');
}
const plainText = s => String(s || '').replace(/\*\*|==/g, '').replace(/\*/g, '').replace(/^[-\u2022]\s+/gm, '').replace(/\s+/g, ' ').trim();
const fmtDay = d => d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
const fmtDue = k => parse(k).toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
const fmtShort2y = k => { const d = parse(k); return `${pad(d.getDate())} ${MONTHS[d.getMonth()].slice(0,3)} ${String(d.getFullYear()).slice(2)}`; };
const levelOf = n => n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;

/* ---------- Sample data ---------- */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (list, r) => list[Math.floor(r() * list.length) % list.length];

const TEXTS = {
  class: [
    'Lecture on **concurrency**: threads share memory, processes do not.\n\n- data races are undefined behaviour\n- a mutex is not a lock on the data, it is a lock on the agreement\n- measure before adding either',
    'Seminar: the reading was about ==distributed consensus== and why two generals cannot agree.\n\n1. timeouts are messages\n2. failure detection is a choice\n3. every guarantee costs latency',
    'Class exercise on recursion. The base case is the whole design; everything after it is bookkeeping.',
    'Statistics lecture: a confidence interval is a statement about the procedure, not about the parameter.',
  ],
  learning: [
    'Read about **HNSW** indexes:\n\n- graphs of near neighbours, layered\n- search starts coarse, then descends\n- recall and speed trade off by `ef`\n\nWorth trying against the sqlite vector table.',
    'Learnings from the deploy: the build was fine, the health check was pointed at the wrong port. Ten minutes to deploy, forty to notice.',
    'Spaced repetition works better when the card asks a question I would actually ask myself.',
    'Read the Workers AI pricing page properly: neurons are billed per model, not per token.',
    'Typing speed is not the bottleneck. Deciding what to write is.',
  ],
  thought: [
    'I keep building tools before I know the problem. The tool is comfortable; the problem is not.',
    'A diary that only records the good days is a press release.',
    'The best filter for a note is whether I would want to read it in a year.',
    'Every abstraction I add now is a question I have to answer later.',
    'Writing something down is a way of finding out that I did not know it.',
  ],
  quote: [
    '"The purpose of computing is insight, not numbers." (Hamming)',
    '"Simplicity is prerequisite for reliability." (Dijkstra)',
    '"You do not rise to the level of your goals, you fall to the level of your systems."',
  ],
  work: [
    'Standup: the migration is behind by a day, the API contract is not the blocker.',
    'Code review notes:\n\n- the retry has no jitter, so the herd comes back together\n- the error message names the field, good\n- delete the commented-out branch before merging',
    'Agreed on the Q4 scope: search first, then the usage report. Everything else waits.',
  ],
  project: [
    'Idea: the diary should be able to show me what I wrote at this hour a year ago.',
    'Sketching the dashboard. Two things to prove: the month is legible at a glance, and the cost per note is visible.',
    'The Telegram bot needs a /undo that survives a restart. That means the capture row is the source of truth, not the message.',
  ],
  life: [
    'Gym at seven. Slept seven hours, energy steady all day.',
    'Walked to the market instead of driving. The tomatoes were worth it.',
    'Called home. Everyone is fine, the roof is still leaking.',
    'Cooked for the week: rice, lentils, too much chilli.',
  ],
  task: [
    'Book the dentist before the end of the month.',
    'Renew the passport application. The photo has to be recent.',
    'Cancel the unused hosting plan.',
    'Back up the photos to the second drive.',
  ],
};
const MODELS = [
  '@cf/meta/llama-3.1-8b-instruct',
  '@cf/zai-org/glm-4.7-flash',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/qwen/qwen2.5-coder-32b-instruct',
];
function usageFor(text, r) {
  const model = pick(MODELS, r);
  const tin = 120 + Math.floor(r() * 240) + Math.min(420, text.length * 3);
  const tout = 40 + Math.floor(r() * 150);
  // Cloudflare bills in neurons, not tokens. This is the estimate the Worker records;
  // the nightly reconciliation is what turns it into the real number.
  const neurons = +(((tin * 1.1) + (tout * 3.3)) / 220).toFixed(2);
  return { model, tin, tout, neurons };
}

function seed() {
  const r = rng(20261024);
  const days = {};
  const today = parse(TODAY);
  const pool = CATS.filter(c => c.id !== 'deadline' && c.id !== 'inbox');

  for (let back = 300; back >= 1; back--) {
    const d = addDays(today, -back);
    if (r() > 0.62) continue;
    const k = iso(d);
    const n = 1 + Math.floor(r() * 4);
    const list = [];
    for (let j = 0; j < n; j++) {
      const cat = pick(pool.map(c => c.id), r);
      const text = pick(TEXTS[cat], r);
      const time = `${pad(6 + Math.floor(r() * 17))}:${pad(Math.floor(r() * 60))}`;
      list.push({
        id: `${k}-${j}`, time, sec: Math.floor(r() * 60), cat,
        mode: pick(['refined','refined','refined','verbatim','think'], r),
        src: pick(['telegram','telegram','web'], r),
        text, raw: r() > 0.55 ? text.replace(/\*\*/g, '').replace(/^[-*] /gm, '') : text,
        usage: usageFor(text, r),
      });
    }
    days[k] = list.sort((a, b) => b.time.localeCompare(a.time));
  }

  // Today is written by hand so the home page has something recognisable in it.
  const todayNotes = [
    { time:'20:12', cat:'thought',  mode:'verbatim', src:'telegram', text:'I keep building tools before I know the problem. The tool is comfortable; the problem is not.' },
    { time:'18:20', cat:'task',     mode:'refined',  src:'telegram', text:'Book the dentist before the end of the month.' },
    { time:'16:05', cat:'learning', mode:'refined',  src:'web',      text:'Read about **HNSW** indexes:\n\n- graphs of near neighbours, layered\n- search starts coarse, then descends\n- recall and speed trade off by the search width\n\nWorth trying against the sqlite vector table.' },
    { time:'09:12', cat:'life',     mode:'refined',  src:'telegram', text:'Gym at seven. Slept seven hours, energy steady all day.' },
  ].map((e, i) => ({ ...e, id:`${TODAY}-t${i}`, sec: 11 * i, raw: e.text, usage: usageFor(e.text, rng(910 + i)) }));

  days[TODAY] = todayNotes.sort((a, b) => b.time.localeCompare(a.time));

  const deadlines = [
    { day: iso(addDays(today, -4)),  time:'09:00', text:'Renew the domain before it expires.',      due: iso(addDays(today, -2)),  done:false, src:'web' },
    { day: TODAY,                    time:'08:30', text:'Send the October invoice to the client.',   due: TODAY,                    done:false, src:'telegram' },
    { day: iso(addDays(today, -1)),  time:'19:40', text:'Return the library books.',                due: iso(addDays(today, 3)),    done:false, src:'telegram' },
    { day: iso(addDays(today, -12)), time:'11:20', text:'File the travel reimbursement.',            due: iso(addDays(today, 10)),   done:false, src:'web' },
    { day: iso(addDays(today, -20)), time:'10:15', text:'Pay the electricity bill.',                due: iso(addDays(today, -8)),   done:true,  src:'telegram' },
  ];
  // The one already-closed sample carries the moment it was closed, like a real one.
  const closedAt = new Date(parse(iso(addDays(today, -9))));
  closedAt.setHours(10, 42, 0, 0);
  deadlines.forEach((dl, i) => {
    const k = dl.day;
    (days[k] = days[k] || []).push({
      id: `${k}-dl${i}`, time: dl.time, sec: 0, cat:'deadline', mode:'refined', src: dl.src,
      text: dl.text, raw: dl.text, due: dl.due, done: dl.done,
      doneAt: dl.done ? closedAt.toISOString() : null, usage: usageFor(dl.text, rng(500 + i)),
    });
    days[k].sort((a, b) => b.time.localeCompare(a.time));
  });

  return days;
}

let state;
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  state = saved && saved.days ? saved : { signedIn: true, days: seed(), heatmap: 'weeks', weekStart: 'mon', tz: 'Europe/Paris' };
} catch (_) {
  state = { signedIn: true, days: seed(), heatmap: 'weeks', weekStart: 'mon', tz: 'Europe/Paris' };
}
if (state.signedIn === undefined) state.signedIn = true;
// The demo keeps its own passphrase in this browser; the real gate is Supabase.
if (typeof state.pass !== 'string' || !state.pass) state.pass = 'demo';
if (!state.heatmap) state.heatmap = 'weeks';
if (!state.weekStart) state.weekStart = 'mon';
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (_) {} };

const items = k => state.days[k] || [];
const tallyInto = (c, list) => list.forEach(it => { c[it.cat] = (c[it.cat] || 0) + 1; });
const monthItems = (y, m) => {
  const out = [];
  for (let d = 1; d <= dim(y, m); d++) {
    const k = `${y}-${pad(m)}-${pad(d)}`;
    items(k).forEach(it => out.push({ ...it, k }));
  }
  return out;
};

/* ---------- Preferences: theme (Minimal, Paper, Dark Journal) and light/dark ---------- */
const SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const THEMES = ['minimal', 'paper', 'journal'];
const THEME_LABEL = { minimal:'Minimal', paper:'Paper', journal:'Dark Journal' };
const prefs = { theme:'minimal', mode:'light' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF) || '{}')); } catch (_) {}
if (!THEMES.includes(prefs.theme)) prefs.theme = 'minimal';
if (!['light', 'dark'].includes(prefs.mode)) prefs.mode = 'light';

function applyPrefs() {
  document.body.dataset.theme = prefs.theme;
  document.body.dataset.mode = prefs.mode;
  const mb = $('#mode-btn');
  if (mb) {
    mb.innerHTML = prefs.mode === 'light' ? MOON_ICON : SUN_ICON;
    mb.setAttribute('aria-label', prefs.mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  }
}
const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch (_) {} };

const ui = { tab:'all', openNote:null, compose:false, moveMenu:false, moveConfirm:null, openRaw:new Set(), dueOpen:false, addMsg:'' };

/* ---------- Search (same tolerant matcher as the app) ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function tokenScore(qt, words, hay) {
  if (hay.includes(qt)) return qt.length >= 4 ? 3 : 2;
  for (const w of words) {
    if (w.startsWith(qt)) return 2;
    if (qt.length >= 4 && w.length >= 4 && lev(qt, w) <= 1) return 1;
  }
  return 0;
}
function scoreNote(qtoks, it, k) {
  const hay = norm(`${it.text} ${CAT[it.cat] ? CAT[it.cat].label : ''} ${MODE_LABEL[it.mode] || ''} ${k} ${fmtDay(parse(k))}`);
  const words = hay.split(' ');
  let s = 0;
  for (const qt of qtoks) {
    const v = tokenScore(qt, words, hay);
    if (!v) return -1;
    s += v + (norm(it.text).startsWith(qt) ? 1 : 0);
  }
  if (norm(it.text).includes(qtoks.join(' '))) s += 3;
  return s;
}
function doSearch(q) {
  const qtoks = norm(q).split(' ').filter(Boolean);
  if (!qtoks.length) return [];
  const out = [];
  for (const [k, list] of Object.entries(state.days)) for (const it of list) {
    const s = scoreNote(qtoks, it, k);
    if (s >= 0) out.push({ k, it, s });
  }
  out.sort((a, b) => b.s - a.s || (a.k < b.k ? 1 : -1) || b.it.time.localeCompare(a.it.time));
  const seen = new Set();
  return out.filter(r => { const t = norm(r.it.text); if (seen.has(t)) return false; seen.add(t); return true; }).slice(0, 8);
}
function hiMark(text, qtoks) {
  let h = esc(text);
  for (const qt of qtoks.slice().sort((a, b) => b.length - a.length)) {
    if (qt.length < 2) continue;
    try { h = h.replace(new RegExp(`(${qt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>'); }
    catch (_) {}
  }
  return h;
}
let searchActive = -1;
function renderSearchPop() {
  const inp = $('#search'), pop = $('#search-pop');
  if (!inp || !pop) return;
  const q = inp.value;
  if (!norm(q)) { pop.hidden = true; pop.innerHTML = ''; searchActive = -1; return; }
  const res = doSearch(q), qtoks = norm(q).split(' ').filter(Boolean);
  searchActive = res.length ? Math.min(Math.max(searchActive, -1), res.length - 1) : -1;
  pop.innerHTML = res.length ? res.map((r, i) => {
    const c = CAT[r.it.cat];
    const { title, body } = splitTitle(r.it.text);
    const rawTitle = (title || r.it.text.split('\n')[0]).trim();
    const tShort = rawTitle.length > 64 ? rawTitle.slice(0, 64).trimEnd() + '…' : rawTitle;
    const rawSnip = (title ? body : r.it.text).replace(/\s+/g, ' ').trim();
    const snip = rawSnip.length > 110 ? rawSnip.slice(0, 110).trimEnd() + '…' : rawSnip;
    return `<button type="button" class="srow${i === searchActive ? ' active' : ''}" data-action="search-open" data-v="${r.k}|${r.it.id}" role="option" aria-selected="${i === searchActive}">
      <span class="sdot" style="background:${c.color}"></span>
      <span class="stxt"><span class="st1">${hiMark(tShort, qtoks)}</span><span class="sline"><span class="ssnip">${hiMark(snip, qtoks)}</span><span class="smeta2">${c.label} · ${fmtShort2y(r.k)}</span></span></span></button>`;
  }).join('') : '<div class="sempty">No matches. Try fewer or different words.</div>';
  pop.hidden = false;
}
function hideSearch() { const pop = $('#search-pop'); if (pop) { pop.hidden = true; pop.innerHTML = ''; } searchActive = -1; }
function openSearchResult(ref) {
  const k = ref.slice(0, ref.indexOf('|'));
  const d = parse(k);
  hideSearch();
  const inp = $('#search'); if (inp) inp.value = '';
  ui.openNote = ref; ui.moveMenu = false; ui.moveConfirm = null;
  go(`#/y/${d.getFullYear()}/m/${d.getMonth()+1}/d/${d.getDate()}`);
}

/* ---------- Routing ---------- */
function route() {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'y' && p[1] && p[2] === 'm' && p[3]) {
    const y = +p[1], m = +p[3];
    if (p[4] === 'd' && p[5]) return { view:'day', y, m, d:+p[5] };
    return { view:'month', y, m };
  }
  if (p[0] === 'dashboard') {
    const now = parse(TODAY);
    // A month is its own page now, so older /dashboard/2026/10 links land there.
    if (p[1] && p[2]) return { view:'month', y:+p[1], m:+p[2] };
    return { view:'year', y: +p[1] || now.getFullYear() };
  }
  if (p[0] === 'settings') return { view:'settings' };
  return { view:'home' };
}
const go = h => { if (location.hash === h) { ui.tab = 'all'; render(); } else location.hash = h; };
const dayLink = dt => `#/y/${dt.getFullYear()}/m/${dt.getMonth()+1}/d/${dt.getDate()}`;

/* ---------- Charts (plain SVG, same as the app) ---------- */
function stackChart(bks, label) {
  const W = 720, H = 240, P = 30, B = 24;
  const totals = bks.map(b => Object.values(b.counts).reduce((a, c) => a + c, 0));
  const max = Math.max(1, ...totals);
  const plotH = H - P - B, slot = (W - P * 2) / bks.length, bw = Math.min(22, slot * 0.58);
  const every = Math.ceil(bks.length / 12);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
  for (let i = 0; i <= 4; i++) {
    const y = P + plotH - plotH * i / 4;
    s += `<line class="grid" x1="${P}" x2="${W-P}" y1="${y}" y2="${y}"/><text class="axis" x="${P-8}" y="${y+4}" text-anchor="end">${Math.round(max*i/4)}</text>`;
  }
  bks.forEach((b, i) => {
    const cx = P + slot * i + slot / 2, x = cx - bw / 2;
    let base = P + plotH;
    CATS.forEach(c => {
      const n = b.counts[c.id]; if (!n) return;
      const full = plotH * n / max; base -= full;
      s += `<rect x="${x}" y="${base + 1}" width="${bw}" height="${Math.max(1, full - 2)}" rx="3" fill="${c.color}"><title>${esc(b.label)} · ${c.label}: ${n}</title></rect>`;
    });
    if (i % every === 0) s += `<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  return s + '</svg>';
}
function compHTML(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return '<p class="muted">No items in this range.</p>';
  const act = CATS.filter(c => counts[c.id]);
  const bar = act.map(c => `<span style="flex:${counts[c.id]};background:${c.color}" title="${c.label}: ${counts[c.id]}"></span>`).join('');
  const keys = act.map(c => `<span class="k"><i style="background:${c.color}"></i>${c.label}<em>${counts[c.id]} · ${Math.round(counts[c.id] / total * 100)}%</em></span>`).join('');
  return `<div class="comp"><div class="bar">${bar}</div><div class="keys">${keys}</div></div>`;
}
function hourHistogram(list, label) {
  const c = Array(24).fill(0);
  list.forEach(it => c[+it.time.slice(0, 2)]++);
  const max = Math.max(1, ...c);
  const W = 720, H = 200, P = 24, bw = (W - P * 2) / 24;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
  c.forEach((n, h) => {
    const hh = (H - P * 2) * n / max, x = P + h * bw + 3, y = H - P - hh;
    s += `<rect class="bar" x="${x}" y="${y}" width="${bw - 6}" height="${hh}" rx="3"><title>${pad(h)}:00 · ${n} items</title></rect>`;
    if (h % 3 === 0) s += `<text class="axis" x="${x + (bw - 6) / 2}" y="${H - 6}" text-anchor="middle">${pad(h)}</text>`;
  });
  return s + '</svg>';
}
function yearHeat(y) {
  let h = '<div class="heat">';
  for (let m = 1; m <= 12; m++) {
    h += `<div class="hrow"><span class="hm">${MONTHS[m-1].slice(0,3)}</span>`;
    for (let d = 1; d <= 31; d++) {
      if (d > dim(y, m)) { h += '<span class="hc blank"></span>'; continue; }
      const k = `${y}-${pad(m)}-${pad(d)}`, n = items(k).length, future = k > TODAY;
      // A day that has passed with nothing in it carries a faint cross, so an empty day
      // reads as empty rather than as unshaded.
      const mark = !n && !future ? '<i class="xmark" aria-hidden="true">×</i>' : '';
      h += `<a class="hc l${levelOf(n)}${future ? ' na' : ''}" href="#/y/${y}/m/${m}/d/${d}" title="${k}: ${n ? `${n} ${n === 1 ? 'item' : 'items'}` : 'no items'}">${mark}</a>`;
    }
    h += '</div>';
  }
  return h + '</div>';
}
function monthCalendar(y, m) {
  const ws = state.weekStart === 'sun' ? 0 : 1;
  const lead = (new Date(y, m-1, 1).getDay() - ws + 7) % 7;
  const labels = ws === 0 ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<span class="cell blank"></span>';
  for (let d = 1; d <= dim(y, m); d++) {
    const k = `${y}-${pad(m)}-${pad(d)}`, n = items(k).length;
    cells += `<a class="cell l${levelOf(n)}" href="#/y/${y}/m/${m}/d/${d}"><b>${d}</b><small>${n ? n + ' items' : ''}</small></a>`;
  }
  return `<div class="cal">${labels.map(x => `<span class="dow">${x}</span>`).join('')}${cells}</div>`;
}
// The month shape of the year heatmap: weeks as rows, a total per week.
function monthWeeks(y, m) {
  const ws = state.weekStart === 'sun' ? 0 : 1;
  const lead = (new Date(y, m-1, 1).getDay() - ws + 7) % 7;
  const labels = ws === 0 ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] : ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= dim(y, m); d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  let rows = '';
  for (let w = 0; w < cells.length / 7; w++) {
    let tot = 0, tds = '';
    for (const d of cells.slice(w * 7, w * 7 + 7)) {
      if (!d) { tds += '<td><span class="wkc blank"></span></td>'; continue; }
      const k = `${y}-${pad(m)}-${pad(d)}`, n = items(k).length, future = k > TODAY;
      tot += n;
      // Same reading as the year heat: a cross where the count would be, on a day that
      // has passed without anything written. Future days stay blank.
      const count = n ? `<i>${n}</i>` : future ? '<i></i>' : '<i class="xmark" aria-hidden="true">×</i>';
      tds += `<td><a class="wkc l${levelOf(n)}${k === TODAY ? ' today' : ''}" href="#/y/${y}/m/${m}/d/${d}" title="${k}: ${n ? `${n} ${n === 1 ? 'item' : 'items'}` : 'no items'}"><b>${d}</b>${count}</a></td>`;
    }
    rows += `<tr>${tds}<td class="tot"><span class="wtot">${tot}</span></td></tr>`;
  }
  return `<table class="weeks"><thead><tr>${labels.map(l => `<th>${l}</th>`).join('')}<th class="tot">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}
function donut(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return '<p class="muted">No items yet.</p>';
  const C = 2 * Math.PI * 40; let cum = 0, arcs = '';
  CATS.forEach(c => {
    const n = counts[c.id] || 0; if (!n) return;
    const f = n / total;
    arcs += `<circle r="40" cx="60" cy="60" fill="none" stroke="${c.color}" stroke-width="16" stroke-dasharray="${f * C} ${C}" stroke-dashoffset="${-cum * C}" transform="rotate(-90 60 60)"><title>${c.label}: ${n}</title></circle>`;
    cum += f;
  });
  return `<div class="donut"><svg viewBox="0 0 120 120">${arcs}<text class="dtot" x="60" y="66" text-anchor="middle">${total}</text></svg>${compHTML(counts)}</div>`;
}

/* ---------- Deadlines ---------- */
function dueDays(due) { return Math.round((parse(due) - parse(TODAY)) / 864e5); }
// When a deadline was closed: a date and a clock time, since a done note without one
// loses the only thing the diary keeps that a to-do app does not.
const fmtStamp = iso => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
function duePill(it) {
  if (it.cat !== 'deadline') return '';
  if (it.done) return `<span class="due done"${it.doneAt ? ` title="Marked done ${esc(fmtStamp(it.doneAt))}"` : ''}>Done</span>`;
  if (!it.due) return '';
  const n = dueDays(it.due);
  if (n < 0) return `<span class="due over">Overdue ${-n}d</span>`;
  if (n === 0) return '<span class="due soon">Due today</span>';
  if (n === 1) return '<span class="due soon">Due tomorrow</span>';
  return `<span class="due soon">Due in ${n}d</span>`;
}
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';

// A deadline is only done when someone says so, and the note is the place they are
// looking when they decide. The button stays afterwards, to reopen a mistake.
function dueLine(it, ref) {
  if (it.cat !== 'deadline') return '';
  const when = it.due ? fmtDay(parse(it.due)) : 'No due date';
  const n = it.due ? dueDays(it.due) : null;
  const st = it.done
    ? (it.doneAt ? `done ${fmtStamp(it.doneAt)}` : 'Done')
    : n === null ? '' : n < 0 ? `${-n} days overdue` : n === 0 ? 'due today' : `${n} days left`;
  return `<div class="duline">${duePill(it)}<span class="muted">${esc(when)}${st ? ` · ${st}` : ''}</span>
    <button class="donetog" data-action="done" data-v="${ref}" aria-pressed="${it.done ? 'true' : 'false'}">${it.done ? 'Reopen' : `${CHECK_ICON}Mark done`}</button></div>`;
}

function toggleDone(ref) {
  const found = findNote(ref);
  if (!found || found.it.cat !== 'deadline') return;
  found.it.done = !found.it.done;
  // The moment it was ticked is stored with it (`done_at`, the column the Worker keeps) and
  // cleared when the tick is undone, so a reopened deadline has no closing time.
  found.it.doneAt = found.it.done ? new Date().toISOString() : null;
  save();
  render();
  toast(found.it.done ? 'Deadline marked done. No more pings.' : 'Deadline reopened.');
}
const hasRawText = it => it.mode !== 'verbatim' && !!it.raw;

/* ---------- Ledger, sheet ---------- */
function ledgerRowHTML(it, k, withDay = false) {
  return `<div class="lrow clickable" data-action="open" data-v="${k}|${it.id}" tabindex="0" role="button" title="Open note">
      <span class="ltime${withDay ? ' wide' : ''}">${withDay ? `${+k.slice(8)} ${it.time}` : it.time}</span>
      <span class="ltxt clamp">${esc(plainText(it.text))}</span>${duePill(it)}
    </div>`;
}
function findNote(ref) {
  const i = ref.indexOf('|');
  const k = ref.slice(0, i), id = ref.slice(i + 1);
  const it = (items(k) || []).find(x => x.id === id);
  return it ? { k, it } : null;
}
function doMove(k, id, cat) {
  const it = (items(k) || []).find(x => x.id === id);
  if (it) { it.cat = cat; it.src = 'manual'; if (cat === 'deadline' && !it.due) { it.due = iso(addDays(parse(k), 7)); it.done = false; } save(); }
}
function splitTitle(t) {
  const s = String(t || '');
  const nl = s.indexOf('\n');
  if (nl > 0) {
    const head = s.slice(0, nl).trim(), rest = s.slice(nl + 1).trim();
    if (head && head.length <= 120 && rest) return { title: head, body: rest };
  }
  const m = s.match(/^([^:\n\.?!]{3,48}):\s+(.{20,})$/s);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  return { title: '', body: s };
}
function noteTitleBody(t) {
  const { title, body } = splitTitle(t);
  const head = title ? `<h3 class="stitle">${inlineHTML(esc(title))}</h3>` : '';
  return `${head}<div class="sfull">${richHTML(body)}</div>`;
}
function noteHTML(ref) {
  const found = findNote(ref);
  if (!found) return '';
  const { k, it } = found;
  const c = CAT[it.cat];
  const hasRaw = hasRawText(it);
  const rawOpen = ui.openRaw.has(it.id);
  const opts = CATS.map(x => `<option value="${x.id}"${x.id === it.cat ? ' selected' : ''}>${x.label}</option>`).join('');
  const moveOpen = ui.moveMenu;
  const u = it.usage;
  return `<div class="overlay"><div class="backdrop" data-action="close-note"></div>
    <div class="sheet nsheet" role="dialog" aria-modal="true" aria-label="Note">
      <div class="shead"><span class="sdot" style="background:${c.color}"></span><strong>${c.label}</strong><span class="mode">${MODE_LABEL[it.mode]}</span><span class="spacer"></span>${hasRaw ? `<button class="hbtn" data-action="raw" data-v="${it.id}" aria-pressed="${rawOpen}" title="${rawOpen ? 'Hide raw' : 'Show raw'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/></svg></button>` : ''}<button class="hbtn" data-action="move-menu" aria-expanded="${moveOpen}" title="Move to another category"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14l3 3 3-3"/></svg></button><button class="xbtn" data-action="close-note" aria-label="Close">\u00d7</button></div>
      ${moveOpen ? `<div class="mmenu" role="menu">${ui.moveConfirm ? `<div class="mconf"><span>Move to <b>${CAT[ui.moveConfirm].label}</b>?</span><span class="row"><button class="btn" data-action="move-yes">Yes</button><button class="btn" data-action="move-no">No</button></span></div>` : CATS.map(x => `<button data-action="move-to" data-v="${x.id}" aria-checked="${x.id === it.cat}"><i style="background:${x.color}"></i>${x.label}</button>`).join('')}</div>` : ''}
      <div class="sbody">
        <div class="smeta">${fmtDay(parse(k))}<i>·</i>${it.time}:${pad(it.sec || 0)}<i>·</i>${it.src === 'tag' ? 'Tagged by you' : it.src === 'manual' ? 'Moved by you' : 'Auto filed'}</div>
        ${dueLine(it, `${k}|${it.id}`)}
        ${noteTitleBody(it.text)}
        ${rawOpen && hasRaw ? `<div class="sraw"><span class="kicker">Raw</span><p>${esc(it.raw)}</p></div>` : ''}
      </div>
      <div class="sfoot"><span class="cost">${u.neurons} neurons · ${u.tin} in / ${u.tout} out tokens · ${u.model.replace('@cf/', '')}</span></div>
    </div></div>`;
}

function ledgerHTML(list, k) {
  if (!list.length) return '<p class="muted">Nothing here yet.</p>';
  if (ui.tab !== 'all') return `<div class="ledg">${list.map(it => ledgerRowHTML(it, k)).join('')}</div>`;
  return CATS.filter(c => list.some(it => it.cat === c.id)).map(c => {
    const rows = list.filter(it => it.cat === c.id);
    return `<div class="lgrp"><i class="gdot" style="background:${c.color}"></i>${c.label} <span class="n">(${rows.length})</span></div><div class="ledg">${rows.map(it => ledgerRowHTML(it, k)).join('')}</div>`;
  }).join('');
}
function dayTabsHTML(defs) {
  return `<div class="tabs tabs-inline" role="tablist">` + defs.map(t =>
    `<button class="tab" role="tab" data-action="tab" data-v="${t.id}" aria-selected="${ui.tab === t.id}">${t.label}<small>${t.n}</small></button>`).join('') + '</div>';
}

/* ---------- Home (v2): the day's entries first, the month beside them ---------- */

const PLUS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';

// The day's four counters, as compact KPI cards rather than chips.
function statCardsHTML(k) {
  const list = items(k), counts = {};
  tallyInto(counts, list);
  const tokens = list.reduce((a, it) => a + it.usage.tin + it.usage.tout, 0);
  const neurons = list.reduce((a, it) => a + it.usage.neurons, 0);
  const cats = Object.keys(counts).length;
  const cards = [
    { n: list.length, label: 'entries', title: `${list.length} ${list.length === 1 ? 'entry' : 'entries'}` },
    { n: cats, label: 'categories', title: `${cats} ${cats === 1 ? 'category' : 'categories'}` },
    { n: tokens.toLocaleString(), label: 'tokens', title: `${tokens.toLocaleString()} tokens in and out` },
    { n: neurons.toFixed(1), label: 'neurons', title: `${neurons.toFixed(1)} neurons, estimated` },
  ];
  // Any day but today carries the way back as a fifth card: same shape, accent fill, and the
  // words stacked on two lines at one size.
  const back = k === TODAY ? ''
    : `<a class="hstat go" href="#/" title="Open today"><b>Open</b><span>Today</span></a>`;
  return `<div class="hstats">${cards.map(c =>
    `<div class="hstat" title="${esc(c.title)}"><b>${c.n}</b><span>${c.label}</span></div>`).join('')}${back}</div>`;
}

function openDeadlines() {
  return Object.entries(state.days)
    .flatMap(([k, list]) => list.filter(it => it.cat === 'deadline' && !it.done && it.due).map(it => ({ ...it, k })))
    .sort((a, b) => a.due.localeCompare(b.due));
}

// One day of entries, led by the category tabs.
function entriesCardHTML(k, home) {
  const list = items(k), counts = {};
  tallyInto(counts, list);
  if (ui.tab !== 'all' && !(counts[ui.tab] > 0)) ui.tab = 'all';
  const shown = ui.tab === 'all' ? list : list.filter(it => it.cat === ui.tab);
  const tabDefs = [{ id:'all', label:'All', n:list.length }, ...CATS.filter(c => counts[c.id] > 0).map(c => ({ id:c.id, label:c.label, n:counts[c.id] }))];
  const body = list.length
    ? ledgerHTML(shown, k)
    : `<div class="emptyday"><p class="muted" style="margin:0">Nothing written ${home ? 'yet today' : 'on this day'}.</p>
        ${home ? `<button class="btn" data-action="compose">Write the first note</button>` : ''}</div>`;
  return `<section class="card">
    <div class="lhead"><span class="kicker">Entries</span>${list.length ? dayTabsHTML(tabDefs) : ''}</div>
    ${body}
  </section>`;
}

// The day's hours in a card of their own: what the day held, and when it happened,
// are two readings, not one.
function hoursCardHTML(k) {
  const list = items(k);
  if (!list.length) return '';
  const c = Array(24).fill(0);
  list.forEach(it => c[+it.time.slice(0, 2)]++);
  const max = Math.max(1, ...c);
  const busy = c.filter(Boolean).length;
  const nowH = new Date().getHours();
  const isToday = k === TODAY;
  const bars = c.map((n, h) =>
    `<span class="${n ? 'has' : ''}${isToday && h === nowH ? ' now' : ''}" style="height:${n ? Math.max(14, Math.round(n / max * 100)) : 5}%" title="${pad(h)}:00 · ${n} ${n === 1 ? 'note' : 'notes'}"></span>`).join('');
  return `<section class="card">
    <div class="lhead" style="margin-bottom:0">
      <div><span class="kicker">Timeline</span><h2 style="margin:2px 0 0">Hours</h2></div>
      <span class="hoursum">${list.length} ${list.length === 1 ? 'note' : 'notes'} · ${busy} ${busy === 1 ? 'hour' : 'hours'} busy</span>
    </div>
    <div class="hbars">${bars}</div>
    <div class="hticks">${Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? pad(h) : ''}</span>`).join('')}</div>
  </section>`;
}

// The month as a heatmap, GitHub shading, one cell per day of this month only.
function monthHeatCard(k) {
  const dt = parse(k), y = dt.getFullYear(), m = dt.getMonth() + 1;
  const ws = state.weekStart === 'sun' ? 0 : 1;
  const labels = ws === 0 ? ['S','M','T','W','T','F','S'] : ['M','T','W','T','F','S','S'];
  const lead = (new Date(y, m - 1, 1).getDay() - ws + 7) % 7;
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= dim(y, m); d++) cells.push(d);
  while (cells.length % 7) cells.push(null);

  const todayDate = parse(TODAY);
  // A month in progress can only be written up to today, so the denominator follows the clock.
  const elapsed = y === todayDate.getFullYear() && m === todayDate.getMonth() + 1 ? todayDate.getDate() : (y > todayDate.getFullYear() || (y === todayDate.getFullYear() && m > todayDate.getMonth() + 1) ? 0 : dim(y, m));
  const counts = {};
  let total = 0, written = 0, best = { d:0, n:0 }, run = 0, streak = 0;
  for (let d = 1; d <= dim(y, m); d++) {
    const kk = `${y}-${pad(m)}-${pad(d)}`, n = items(kk).length;
    counts[d] = n; total += n;
    if (n) { written++; run++; if (run > streak) streak = run; } else run = 0;
    if (n > best.n) best = { d, n };
  }

  const grid = cells.map(d => {
    if (!d) return '<span class="mc blank"></span>';
    const kk = `${y}-${pad(m)}-${pad(d)}`, n = counts[d], future = kk > TODAY;
    return `<a class="mc l${levelOf(n)}${kk === TODAY ? ' today' : ''}${future ? ' future' : ''}" href="${dayLink(new Date(y, m - 1, d))}" title="${fmtShort2y(kk)} · ${n} ${n === 1 ? 'item' : 'items'}">${d}</a>`;
  }).join('');

  return `<section class="card railcard">
    <div class="lhead" style="margin-bottom:10px;align-items:flex-start">
      <div><span class="kicker">This month</span><h2 style="margin:2px 0 0">${MONTHS[m - 1]} ${y}</h2></div>
      <a class="microbtn" href="#/y/${y}/m/${m}">Open month →</a>
    </div>
    <div class="mhd">${labels.map(l => `<span>${l}</span>`).join('')}</div>
    <div class="mgrid">${grid}</div>
    <div class="mlegend"><span>Less</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>More</span></div>
    <div class="mlabel"><span>Written</span><b>${elapsed ? `${written} of ${elapsed} days · ${total} items` : `${total} items`}</b></div>
    <div class="mlabel"><span>Longest run</span><b>${streak} ${streak === 1 ? 'day' : 'days'}</b></div>
    <div class="mlabel"><span>Best day</span><b>${best.d ? `${best.d} ${MONTHS[m - 1].slice(0, 3)} · ${best.n}` : 'No day yet'}</b></div>
  </section>`;
}

function whenCard(k) {
  const dt = parse(k), y = dt.getFullYear(), m = dt.getMonth() + 1;
  const list = monthItems(y, m);
  const c = Array(24).fill(0);
  list.forEach(it => c[+it.time.slice(0, 2)]++);
  const max = Math.max(1, ...c);
  const peak = c.indexOf(Math.max(...c));
  const bars = c.map((n, h) => `<span class="${n ? 'has' : ''}" style="height:${n ? Math.max(12, Math.round(n / max * 100)) : 4}%" title="${pad(h)}:00 · ${n} ${n === 1 ? 'note' : 'notes'}"></span>`).join('');
  return `<section class="card railcard">
    <div class="lhead" style="margin-bottom:2px"><div><span class="kicker">Rhythm</span><h2 style="margin:2px 0 0">When you write</h2></div>
      <span class="muted" style="font-size:.74rem">${MONTHS[m - 1].slice(0, 3)}</span></div>
    <div class="wbar">${bars}</div>
    <div class="wax"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>
    <p class="note" style="margin-top:8px">${list.length ? `Most notes in ${MONTHS[m - 1]} land around ${pad(peak)}:00, ${c[peak]} of ${list.length}.` : 'Nothing this month yet.'}</p>
  </section>`;
}

function dueCard() {
  const open = openDeadlines();
  const overdue = open.filter(it => dueDays(it.due) < 0).length;
  return `<section class="card railcard">
    <div class="lhead" style="margin-bottom:4px;align-items:flex-start">
      <div><span class="kicker">Deadlines</span><h2 style="margin:2px 0 0">Due</h2></div>${open.length
      ? `<span class="due ${overdue ? 'over' : 'soon'}">${overdue ? `${overdue} overdue` : `${open.length} open`}</span>` : ''}</div>
    ${open.length ? open.slice(0, 5).map(it => `<div class="lrow clickable" data-action="open" data-v="${it.k}|${it.id}" tabindex="0" role="button" title="Open note">
        <span class="ltxt"><b>${esc(plainText(it.text))}</b><br><span class="muted" style="font-size:.76rem">${fmtShort2y(it.due)} · ${CAT[it.cat].label}</span></span>${duePill(it)}<button class="tick" data-action="done" data-v="${it.k}|${it.id}" title="Mark done" aria-label="Mark done">${CHECK_ICON}</button>
      </div>`).join('')
      : '<p class="muted" style="margin:0">Nothing open.</p>'}
    <p class="note"><a class="microbtn" href="#/dashboard">The dashboard →</a></p>
  </section>`;
}

function composerSheetHTML() {
  const now = new Date();
  return `<div class="overlay"><div class="backdrop" data-action="close-compose"></div>
    <div class="sheet csheet" role="dialog" aria-modal="true" aria-label="New note">
      <div class="shead"><span class="sdot" style="background:var(--accent)"></span><strong>New note</strong>
        <span class="mode">${fmtShort2y(TODAY)} · ${pad(now.getHours())}:${pad(now.getMinutes())}</span><span class="spacer"></span>
        <button class="xbtn" data-action="close-compose" aria-label="Close">\u00d7</button></div>
      <p class="chint">Filed into today. The cleanup runs on save; the category is only a guess you can change.</p>
      <textarea id="add-text" placeholder="Type a thought, quote or note…" aria-label="Note text"></textarea>
      <div class="addmsg" id="add-msg" role="status" aria-live="polite">${esc(ui.addMsg || '')}</div>
      <div class="crow">
        <select id="add-mode" aria-label="Cleanup mode"><option value="refined">Refined</option><option value="verbatim">Verbatim</option><option value="reason">Reason</option><option value="think">Think</option></select>
        <select id="add-cat" aria-label="Category"><option value="">Auto (Inbox for now)</option>${CATS.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}</select>
        <span class="spacer"></span>
        <button class="btn csave" data-action="add">Add note</button>
      </div>
      <p class="chint">\u2318\u21b5 adds it. Esc closes.</p>
    </div></div>`;
}

function dayPage(y, m, d, home) {
  const k = `${y}-${pad(m)}-${pad(d)}`, date = parse(k), list = items(k);
  const dow = date.toLocaleDateString('en-GB', { weekday: 'long' });
  const dmy = `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)} ${String(date.getFullYear()).slice(2)}`;
  return `
  <section class="hero dayhead">
    <div class="daynav">
      <a class="btn" href="${dayLink(addDays(date, -1))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg><span class="bl-full">Previous day</span><span class="bl-short">Previous</span></a>
      <h1 class="daytitle"><span class="dow">${dow}</span><span class="dmy">${dmy}</span></h1>      <a class="btn" href="${dayLink(addDays(date, 1))}"><span class="bl-full">Next day</span><span class="bl-short">Next</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></a>
    </div>
  </section>
  <div class="split">
    <div class="stack">${entriesCardHTML(k, home)}${hoursCardHTML(k)}</div>
    <aside class="side">
      ${monthHeatCard(k)}
      ${dueCard()}
      ${whenCard(k)}
    </aside>
  </div>`;
}

/* ---------- Month and year: one page at two zooms ---------- */
// The month page and the dashboard are the same page: same blocks, same order, one scoped
// to a month and one to the whole year it sits in. Only the buckets and the arrows differ.
function yearItems(y) {
  const out = [];
  for (let m = 1; m <= 12; m++) monthItems(y, m).forEach(it => out.push(it));
  return out;
}
function yearBuckets(y) {
  return MONTHS.map((name, i) => {
    const counts = {};
    tallyInto(counts, monthItems(y, i + 1));
    return { label: name.slice(0, 3), counts };
  });
}
const newestFirst = list => [...list].sort((a, b) => a.k === b.k ? b.time.localeCompare(a.time) : (a.k < b.k ? 1 : -1));

function monthBuckets(y, m) {
  return Array.from({ length: dim(y, m) }, (_, i) => {
    const counts = {};
    tallyInto(counts, items(`${y}-${pad(m)}-${pad(i + 1)}`));
    return { label: String(i + 1), counts };
  });
}

/* ---------- Readings: one sentence of pattern under each chart ---------- */
// Every chart on these pages closes the same way: a tinted line that says what the shape
// means. The numbers are computed from the same entries the chart draws, not typed in.
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
// One diamond, centred: the mark of an insight in this page's language.
const INSIGHT_ICON = '<svg class="insight" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2Q13.5 10.5 22 12Q13.5 13.5 12 22Q10.5 13.5 2 12Q10.5 10.5 12 2Z"/></svg>';
function readingHTML(text) {
  return text ? `<p class="reading">${INSIGHT_ICON}<span>${text}</span></p>` : '';
}

function hourReading(list) {
  if (list.length < 4) return '';
  const c = Array(24).fill(0);
  list.forEach(it => c[+it.time.slice(0, 2)]++);
  const peak = c.indexOf(Math.max(...c));
  const pct = h => Math.round(c[h] / list.length * 100);
  const eve = list.filter(it => +it.time.slice(0, 2) >= 18).length;
  const mor = list.filter(it => { const h = +it.time.slice(0, 2); return h >= 6 && h < 12; }).length;
  const night = list.filter(it => +it.time.slice(0, 2) < 5).length;
  const p = n => Math.round(n / list.length * 100);
  const tilt = eve >= mor
    ? `Evenings from 18:00 hold the larger share at ${p(eve)}%, against ${p(mor)}% before noon`
    : `Mornings before noon hold the larger share at ${p(mor)}%, against ${p(eve)}% from 18:00`;
  return `${tilt}. The busiest hour is ${pad(peak)}:00, ${pct(peak)}% of the notes.` +
    (night ? ` ${night} ${night === 1 ? 'note was' : 'notes were'} written after midnight.` : ' Nothing is written between midnight and five.');
}

function activityReading(list, isYear, y, m) {
  if (!list.length) return '';
  const bks = isYear ? yearBuckets(y) : monthBuckets(y, m);
  const totals = bks.map(b => Object.values(b.counts).reduce((a, n) => a + n, 0));
  let best = 0;
  totals.forEach((n, i) => { if (n > totals[best]) best = i; });
  const pct = Math.round(totals[best] / list.length * 100);
  const empty = totals.filter(n => !n).length;
  const wd = Array(7).fill(0);
  list.forEach(it => wd[parse(it.k).getDay()]++);
  const topWd = wd.indexOf(Math.max(...wd));
  const lead = isYear
    ? `${MONTHS[best]} leads with ${totals[best]} items (${pct}%)`
    : `${best + 1} ${MONTHS[m-1].slice(0, 3)} is the fullest day with ${totals[best]} items (${pct}%)`;
  const quiet = empty
    ? `, and ${empty} ${empty === 1 ? (isYear ? 'month is' : 'day is') : (isYear ? 'months are' : 'days are')} empty`
    : '';
  return `${lead}${quiet}. ${WEEKDAYS[topWd]} carries the most, ${Math.round(wd[topWd] / list.length * 100)}% of everything written.`;
}

function coverageReading(y, m) {
  const first = m ? `${y}-${pad(m)}-01` : `${y}-01-01`;
  const full = m ? `${y}-${pad(m)}-${pad(dim(y, m))}` : `${y}-12-31`;
  const last = full < TODAY ? full : TODAY;
  const scopeName = m ? `${MONTHS[m - 1]} ${y}` : `${y}`;
  const over = full < TODAY;   // the range has closed, so "yet" would be a lie
  if (first > last) return `Nothing written in ${scopeName} yet.`;
  let span = 0, written = 0, run = 0, best = 0;
  for (let t = parse(first); iso(t) <= last; t = addDays(t, 1)) {
    span++;
    if (items(iso(t)).length) { written++; run++; if (run > best) best = run; } else run = 0;
  }
  if (!written) return `Nothing written in ${scopeName}${over ? '' : ' yet'}.`;
  const blank = span - written;
  const pct = Math.round(written / span * 100);
  return `You wrote on ${written} of ${span} days${last === full ? '' : ' so far'} (${pct}%), ${blank ? `leaving ${blank} blank` : 'not one blank'}. The longest run is ${best} ${best === 1 ? 'day' : 'days'}.`;
}

function statsPage(y, m) {
  const isYear = !m;
  const now = parse(TODAY);
  const list = isYear ? yearItems(y) : monthItems(y, m);
  const counts = {};
  tallyInto(counts, list);
  const activeDays = new Set(list.map(it => it.k)).size;
  const tokensIn = list.reduce((a, it) => a + it.usage.tin, 0);
  const tokensOut = list.reduce((a, it) => a + it.usage.tout, 0);
  const neurons = list.reduce((a, it) => a + it.usage.neurons, 0);
  const openDl = Object.values(state.days).flat().filter(it => it.cat === 'deadline' && !it.done).length;
  const byModel = {};
  list.forEach(it => {
    const mm = (byModel[it.usage.model] = byModel[it.usage.model] || { calls:0, tin:0, tout:0, neurons:0 });
    mm.calls++; mm.tin += it.usage.tin; mm.tout += it.usage.tout; mm.neurons += it.usage.neurons;
  });
  const recent = newestFirst(list).slice(0, 8);
  const scope = isYear ? `${y}` : `${MONTHS[m-1]} ${y}`;

  // Previous | the scope, centred | next: the day page's header, at these two sizes.
  let nav;
  if (isYear) {
    nav = `<a class="btn" href="#/dashboard/${y - 1}">‹ ${y - 1}</a>
      <h1 class="daytitle"><span class="dow">Dashboard</span><span class="dmy">${y}</span></h1>
      <a class="btn" href="#/dashboard/${y + 1}">${y + 1} ›</a>`;
  } else {
    const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
    const nm = m === 12 ? 1 : m + 1, ny = m === 12 ? y + 1 : y;
    nav = `<a class="btn" href="#/y/${py}/m/${pm}">‹ ${MONTHS[pm-1].slice(0, 3)}</a>
      <h1 class="daytitle"><span class="dow">${y}</span><span class="dmy">${MONTHS[m-1]}</span></h1>
      <a class="btn" href="#/y/${ny}/m/${nm}">${MONTHS[nm-1].slice(0, 3)} ›</a>`;
  }

  const heat = isYear
    ? `<section class="card chartcard"><span class="kicker">Heatmap</span><h2>The year in weeks</h2>
        ${yearHeat(y)}
        <p class="note">One square per day of ${y}, shaded by how many items it holds; a cross marks a day that has passed with nothing written.</p>
        ${readingHTML(coverageReading(y))}</section>`
    : `<section class="card chartcard">
        <div class="navrow act-head">
          <div class="act-title"><span class="kicker">Heatmap</span><h2 style="margin:2px 0 0">${MONTHS[m-1]} in weeks</h2></div>
          <div class="seg">
            <button data-action="heatmap" data-v="weeks" aria-pressed="${state.heatmap === 'weeks'}">Weeks table</button>
            <button data-action="heatmap" data-v="grid" aria-pressed="${state.heatmap === 'grid'}">Calendar grid</button>
          </div>
        </div>
        ${state.heatmap === 'weeks' ? monthWeeks(y, m) : monthCalendar(y, m)}
        <p class="note">Shade is the number of items that day; the right-hand column totals each week. Every day opens.</p>
        ${readingHTML(coverageReading(y, m))}</section>`;

  const pick = isYear
    ? `<div class="card"><span class="kicker">Months</span><h2>Open a month</h2>
        <div class="folders" style="grid-template-columns:repeat(3,1fr)">${MONTHS.map((name, i) => {
          const n = monthItems(y, i + 1).length;
          const future = `${y}-${pad(i + 1)}-01` > TODAY;
          return `<a class="folder${future ? ' off' : ''}" href="#/y/${y}/m/${i + 1}"><strong>${name}</strong><span>${n} items</span></a>`;
        }).join('')}</div></div>`
    : dueCard();

  const recentLink = isYear
    ? `<a class="microbtn" href="#/y/${y}/m/${now.getFullYear() === y ? now.getMonth() + 1 : 1}">Open a month →</a>`
    : `<a class="microbtn" href="#/dashboard/${y}">The year →</a>`;

  return `
  <section class="hero dayhead">
    <div class="daynav">${nav}</div>
    <div class="subrow">
      <p class="muted">${list.length} ${list.length === 1 ? 'item' : 'items'} over ${activeDays} ${activeDays === 1 ? 'day' : 'days'}</p>
    </div>
  </section>

  <section class="kpis">
    <div class="kpi"><b>${list.length}</b><span>items</span></div>
    <div class="kpi"><b>${activeDays}</b><span>active days</span></div>
    <div class="kpi"><b>${Object.keys(counts).length}</b><span>categories</span></div>
    <div class="kpi"><b>${openDl}</b><span>open deadlines</span></div>
    <div class="kpi"><b>${neurons.toFixed(0)}</b><span>neurons ${isYear ? 'this year' : 'this month'}</span></div>
  </section>

  ${heat}

  <section class="grid2">
    <div class="card chartcard">
      <span class="kicker">Activity</span><h2>${isYear ? `${y}, month by month` : `${MONTHS[m-1]}, day by day`}</h2>
      ${isYear
        ? stackChart(yearBuckets(y), 'Items by month, stacked by category')
        : stackChart(monthBuckets(y, m), 'Items by day, stacked by category')}
      <div style="margin-top:14px">${compHTML(counts)}</div>
      ${readingHTML(activityReading(list, isYear, y, m))}
    </div>
    <div class="card chartcard">
      <span class="kicker">When you write</span><h2>Hour of day · ${scope}</h2>
      ${hourHistogram(list, `Items by hour of day, ${scope}`)}
      ${readingHTML(hourReading(list))}
    </div>
  </section>

  <section class="grid2">
    <div class="card">
      <span class="kicker">AI usage</span><h2>${scope}, what the cleanup cost</h2>
      <div class="bignum">${neurons.toFixed(1)} <span>estimated neurons</span></div>
      <div class="meter"><span style="width:${Math.min(100, neurons / (isYear ? 16 : 1.5))}%"></span></div>
      <p class="note">${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out tokens over ${list.length} notes · ${(neurons / Math.max(1, list.length)).toFixed(2)} per note.</p>
      <table class="models">
        <thead><tr><th>Model</th><th class="num">Notes</th><th class="num">Tokens</th><th class="num">Neurons</th></tr></thead>
        <tbody>${Object.entries(byModel).sort((a, b) => b[1].neurons - a[1].neurons).map(([model, v]) =>
          `<tr><td>${esc(model.replace('@cf/', ''))}</td><td class="num">${v.calls}</td><td class="num">${(v.tin + v.tout).toLocaleString()}</td><td class="num">${v.neurons.toFixed(1)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="note">Estimated from the tokens recorded with each note. The billed total is reconciled nightly.</p>
    </div>
    ${pick}
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Recent notes</span>${recentLink}</div>
    <h2>Newest first, with what each cost</h2>
    ${recent.length ? recent.map(it => `<div class="lrow clickable" data-action="open" data-v="${it.k}|${it.id}" tabindex="0" role="button" title="Open note">
      <span class="ltime${isYear ? ' wide' : ''}">${isYear ? fmtShort2y(it.k) : +it.k.slice(8)} ${it.time}</span>
      <span class="ltxt clamp"><i class="dot" style="background:${CAT[it.cat].color}"></i>${esc(plainText(it.text))}</span>
      <span class="cost">${it.usage.neurons} n · ${it.usage.tin + it.usage.tout} tok</span>
    </div>`).join('') : `<p class="muted">Nothing in ${scope} yet.</p>`}
  </section>`;
}

/* ---------- Settings ---------- */
function viewSettings() {
  return `
  <section class="hero sethead">
    <div>
      <span class="kicker">Settings</span><h1>Preferences</h1>
      <p class="muted" style="margin:0">Theme, how the month is drawn, the passphrase, and the account this diary belongs to.</p>
    </div>
    <button class="dangerbtn" data-action="signout" title="Locks the diary until the passphrase is entered again">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>Sign out</button>
  </section>
  <section class="card">
    <div class="setrow"><div><span class="lab">Theme</span><span class="sub">Minimal, Paper, Dark Journal</span></div>
      <div class="seg">${THEMES.map(t => `<button data-action="theme-set" data-v="${t}" aria-pressed="${prefs.theme === t}">${THEME_LABEL[t]}</button>`).join('')}</div></div>
    <div class="setrow"><div><span class="lab">Mode</span><span class="sub">Light or dark</span></div>
      <div class="seg"><button data-action="mode-set" data-v="light" aria-pressed="${prefs.mode === 'light'}">Light</button><button data-action="mode-set" data-v="dark" aria-pressed="${prefs.mode === 'dark'}">Dark</button></div></div>
    <div class="setrow"><div><span class="lab">Month heatmap</span><span class="sub">Both shapes are here; this picks the default</span></div>
      <div class="seg"><button data-action="heatmap" data-v="weeks" aria-pressed="${state.heatmap === 'weeks'}">Weeks table</button><button data-action="heatmap" data-v="grid" aria-pressed="${state.heatmap === 'grid'}">Calendar grid</button></div></div>
    <div class="setrow"><div><span class="lab">Week starts</span><span class="sub">Applied to both month views</span></div>
      <select id="set-week"><option value="mon"${state.weekStart === 'mon' ? ' selected' : ''}>Monday</option><option value="sun"${state.weekStart === 'sun' ? ' selected' : ''}>Sunday</option></select></div>
    <div class="setrow"><div><span class="lab">Timezone</span><span class="sub">Decides which day a note belongs to</span></div>
      <select id="set-tz">${['Europe/Paris','Asia/Kolkata','UTC'].map(tz => `<option${state.tz === tz ? ' selected' : ''}>${tz}</option>`).join('')}</select></div>
    <div class="setrow"><div><span class="lab">Account</span><span class="sub">aweditya.sm@gmail.com · confirmed</span></div>
      <span class="muted" style="font-size:.76rem;font-family:ui-monospace,monospace">9d6eb0f3…b3b2</span></div>
    <div class="setrow"><div><span class="lab">Entries</span><span class="sub">Stored on this device</span></div>
      <button class="btn" data-action="reset">Reset</button></div>
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Access</span></div>
    <h2>Change the passphrase</h2>
    <form class="passform" id="pass-form" autocomplete="off">
      <label class="field"><span>Current passphrase</span><input id="pass-cur" type="password" autocomplete="current-password" /></label>
      <label class="field"><span>New passphrase</span><input id="pass-new" type="password" autocomplete="new-password" /></label>
      <label class="field"><span>Repeat the new one</span><input id="pass-rep" type="password" autocomplete="new-password" /></label>
      <div class="passrow">
        <button class="cbtn" type="submit">Save the new passphrase</button>
        <span class="pmsg" id="pass-msg" role="status" aria-live="polite"></span>
      </div>
    </form>
    <p class="note">Six characters or more. The old one stops working the moment you save, and the diary asks for the new one next time it locks.</p>
  </section>`;
}

// The demo's gate, in the browser only. The rules are the ones the Worker enforces: a wrong
// current passphrase, a short one, and a mismatch each say which field is at fault.
function changePass() {
  const cur = $('#pass-cur'), nw = $('#pass-new'), rp = $('#pass-rep'), msg = $('#pass-msg');
  if (!cur || !nw || !rp) return;
  const fail = (text, el) => {
    [cur, nw, rp].forEach(i => i.removeAttribute('aria-invalid'));
    el.setAttribute('aria-invalid', 'true');
    el.focus();
    if (msg) { msg.textContent = text; msg.className = 'pmsg err'; }
  };
  if (cur.value !== state.pass) return fail('That is not the current passphrase.', cur);
  if (nw.value.length < 6) return fail('Use at least six characters.', nw);
  if (nw.value !== rp.value) return fail('The two new ones do not match.', rp);
  if (nw.value === state.pass) return fail('That is the passphrase you already have.', nw);
  state.pass = nw.value;
  save();
  cur.value = ''; nw.value = ''; rp.value = '';
  [cur, nw, rp].forEach(i => i.removeAttribute('aria-invalid'));
  if (msg) { msg.textContent = 'Saved. It is the only passphrase that opens this diary now.'; msg.className = 'pmsg ok'; }
  toast('Passphrase changed.');
}

/* ---------- Crumbs + render ---------- */
const iconSVG = (body, attrs = '') => `<svg ${attrs}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const DASH_ICON = iconSVG('<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>');
const HOME_BODY = '<path d="M3.4 10.5 12 3.4l8.6 7.1"/><path d="M5.6 9.4V20a.6.6 0 0 0 .6.6h4.2v-5.5h3.2v5.5h4.2a.6.6 0 0 0 .6-.6V9.4"/>';
const HOME_ICON = iconSVG(HOME_BODY);
// Home's own mark in the breadcrumb: the house with an accent roof and an arched door,
// drawn rather than wired, since it is a label and not a button.
const HOME_CRUMB = '<svg role="img" aria-label="Home" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3.1 20.8 10.5H3.2Z" style="fill:var(--accent)"/>' +
  '<path d="M5.2 10.5v8.4a1.6 1.6 0 0 0 1.6 1.6h10.4a1.6 1.6 0 0 0 1.6-1.6v-8.4"/>' +
  '<path d="M10.4 20.5v-3.1a1.6 1.6 0 0 1 3.2 0v3.1Z" fill="currentColor" stroke="none"/>' +
  '</svg>';

// The bar's fourth icon is wherever you are not: on the dashboard it offers the way home,
// on every other page it offers the dashboard.
function syncNav(r) {
  const a = $('#nav-dash');
  if (!a) return;
  const onDash = r.view === 'year';
  a.setAttribute('href', onDash ? '#/' : '#/dashboard');
  a.setAttribute('title', onDash ? 'Home' : 'Dashboard');
  a.setAttribute('aria-label', onDash ? 'Home' : 'Dashboard');
  a.innerHTML = onDash ? HOME_ICON : DASH_ICON;
}

function renderCrumbs(r) {
  const row = $('#crumbrow'), c = $('#crumbs'), tools = $('#crumbtools');
  if (!row || !c || !tools) return;
  row.hidden = false;
  // The trail names where you are, on every page including today's. The day's counters
  // ride at its right end, so the page opens with the date rather than with a second row.
  // Home names itself with the house, the way the bar does; everywhere else the trail opens
  // with the word as a link back to it.
  let trail = '<a href="#/">Home</a>';
  if (r.view === 'home') trail = `<span class="crumbhome" title="Home">${HOME_CRUMB}</span>`;
  if (r.view === 'year') trail += `<span class="sep">/</span><a href="#/dashboard">Dashboard</a><span class="sep">/</span><span aria-current="page">${r.y}</span>`;
  if (r.view === 'settings') trail += '<span class="sep">/</span><span aria-current="page">Settings</span>';
  if (r.view === 'month' || r.view === 'day') trail += `<span class="sep">/</span><a href="#/y/${r.y}/m/${r.m}">${MONTHS[r.m-1]} ${r.y}</a>`;
  if (r.view === 'day') trail += `<span class="sep">/</span><span aria-current="page">${r.d}</span>`;
  const isDay = r.view === 'home' || r.view === 'day';
  const k = r.view === 'home' ? TODAY : `${r.y}-${pad(r.m)}-${pad(r.d)}`;
  // A month or a year that is not the current one carries its way back here, at the row's
  // right end, instead of under the date where it read as part of the sentence.
  const now = parse(TODAY);
  let back = '';
  if (r.view === 'year' && r.y !== now.getFullYear()) {
    back = `<a class="microbtn" href="#/dashboard/${now.getFullYear()}">Back to this year →</a>`;
  }
  if (r.view === 'month' && (r.y !== now.getFullYear() || r.m !== now.getMonth() + 1)) {
    back = `<a class="microbtn" href="#/y/${now.getFullYear()}/m/${now.getMonth() + 1}">Back to this month →</a>`;
  }
  c.innerHTML = trail;
  tools.innerHTML = isDay
    ? `${statCardsHTML(k)}${r.view === 'home'
        ? `<button class="newbtn" data-action="compose" title="New note (n)">${PLUS_ICON}<span>New note</span></button>` : ''}`
    : back;
}
function render() {
  const r = route();
  const signinEl = $('#signin'), appEl = $('#app');
  if (!state.signedIn) {
    if (signinEl) signinEl.hidden = false;
    if (appEl) appEl.hidden = true;
    const row = $('#crumbrow');
    if (row) { row.hidden = true; $('#crumbs').innerHTML = ''; $('#crumbtools').innerHTML = ''; }
    return;
  }
  if (signinEl) signinEl.hidden = true;
  if (appEl) appEl.hidden = false;
  syncNav(r);
  renderCrumbs(r);
  const t = parse(TODAY);
  appEl.innerHTML =
    r.view === 'year' ? statsPage(r.y) :
    r.view === 'settings' ? viewSettings() :
    r.view === 'month' ? statsPage(r.y, r.m) :
    r.view === 'day' ? dayPage(r.y, r.m, r.d, false) :
    dayPage(t.getFullYear(), t.getMonth() + 1, t.getDate(), true);
  document.querySelector('.overlay')?.remove();
  if (ui.compose) {
    document.body.insertAdjacentHTML('beforeend', composerSheetHTML());
    const box = document.querySelector('#add-text');
    if (box) box.focus();
  } else if (ui.openNote) {
    const html = noteHTML(ui.openNote);
    if (html) document.body.insertAdjacentHTML('beforeend', html); else ui.openNote = null;
  }
}

/* ---------- Composer (local only) ---------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}
function addEntry() {
  const box = $('#add-text');
  const text = box ? box.value.trim() : '';
  if (!text) { ui.addMsg = 'Write something first.'; render(); return; }
  const catEl = $('#add-cat'), modeEl = $('#add-mode');
  const cat = (catEl && catEl.value) || 'inbox';
  const mode = (modeEl && modeEl.value) || 'refined';
  const now = new Date();
  const entry = {
    id: `${TODAY}-n${Date.now()}`, time: `${pad(now.getHours())}:${pad(now.getMinutes())}`, sec: now.getSeconds(),
    cat, mode, src: 'web', text, raw: text, usage: usageFor(text, rng(text.length * 7 + cat.length + 3)),
  };
  if (cat === 'deadline') entry.due = iso(addDays(parse(TODAY), 7));
  (state.days[TODAY] = state.days[TODAY] || []).unshift(entry);
  save();
  ui.compose = false; ui.addMsg = ''; ui.openNote = null;
  render();
  toast(mode === 'verbatim' ? 'Saved as written.' : `Saved and filed under ${CAT[cat].label}.`);
}

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (!t) {
    if (!e.target.closest('.search-wrap')) hideSearch();
    if (ui.moveMenu) { ui.moveMenu = false; ui.moveConfirm = null; render(); }
    return;
  }
  const a = t.dataset.action, v = t.dataset.v;
  if (a === 'mode-toggle') { prefs.mode = prefs.mode === 'light' ? 'dark' : 'light'; applyPrefs(); savePrefs(); }
  else if (a === 'mode-set') { prefs.mode = v; applyPrefs(); savePrefs(); render(); }
  else if (a === 'theme-set') { prefs.theme = v; applyPrefs(); savePrefs(); render(); }
  else if (a === 'tab') { ui.tab = v; render(); }
  else if (a === 'compose') { ui.compose = true; ui.openNote = null; ui.moveMenu = false; ui.addMsg = ''; render(); }
  else if (a === 'close-compose') { ui.compose = false; ui.addMsg = ''; render(); }
  else if (a === 'open') { ui.openNote = v; ui.moveMenu = false; ui.moveConfirm = null; render(); }
  else if (a === 'close-note') { ui.openNote = null; ui.moveMenu = false; ui.moveConfirm = null; render(); }
  else if (a === 'done') toggleDone(v);
  else if (a === 'raw') { ui.moveMenu = false; ui.moveConfirm = null; ui.openRaw.has(v) ? ui.openRaw.delete(v) : ui.openRaw.add(v); render(); }
  else if (a === 'move-menu') { ui.moveMenu = !ui.moveMenu; ui.moveConfirm = null; render(); }
  else if (a === 'move-to') { ui.moveConfirm = v; render(); }
  else if (a === 'move-no') { ui.moveConfirm = null; render(); }
  else if (a === 'move-yes') { const f = ui.openNote && findNote(ui.openNote); if (f && ui.moveConfirm) doMove(f.k, f.it.id, ui.moveConfirm); ui.moveConfirm = null; ui.moveMenu = false; render(); }
  else if (a === 'heatmap') { state.heatmap = v; save(); render(); }
  else if (a === 'add') addEntry();
  else if (a === 'search-open') openSearchResult(v);
  else if (a === 'signin') { state.signedIn = true; save(); render(); }
  else if (a === 'signout') { state.signedIn = false; save(); ui.openNote = null; ui.compose = false; render(); }
  else if (a === 'reset') { state.days = seed(); save(); ui.addMsg = 'Entries reset.'; go('#/'); }
});
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'search') { searchActive = -1; renderSearchPop(); }
});
document.addEventListener('keydown', e => {
  const inp = e.target && e.target.id === 'search' ? e.target : null;
  if (inp) {
    const pop = $('#search-pop');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = pop ? pop.querySelectorAll('[data-action="search-open"]').length : 0;
      if (!n) return;
      e.preventDefault();
      searchActive = e.key === 'ArrowDown' ? (searchActive + 1) % n : (searchActive - 1 + n) % n;
      renderSearchPop();
    } else if (e.key === 'Enter') {
      const first = pop ? pop.querySelector(searchActive >= 0 ? `[data-action="search-open"]:nth-child(${searchActive + 1})` : '[data-action="search-open"]') : null;
      if (first) { e.preventDefault(); openSearchResult(first.dataset.v); }
    }
    return;
  }
  const tag = (e.target && e.target.tagName || '').toLowerCase();
  const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
  // The composer is a sheet, so it needs its own submit key.
  if (ui.compose && e.target && e.target.id === 'add-text' && (e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault(); addEntry(); return;
  }
  if (e.key === '/') {
    if (typing) return;
    e.preventDefault();
    const s = $('#search'); if (s) s.focus();
  }
  if (e.key === 'n' && !typing && !e.metaKey && !e.ctrlKey && state.signedIn) {
    e.preventDefault();
    ui.compose = true; ui.openNote = null; ui.addMsg = ''; render(); return;
  }
  if (e.key === 'Escape') {
    hideSearch();
    if (ui.compose) { ui.compose = false; ui.addMsg = ''; render(); return; }
    if (ui.openNote) { ui.openNote = null; ui.moveMenu = false; render(); }
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'set-week') { state.weekStart = e.target.value; save(); render(); }
  if (e.target.id === 'set-tz') { state.tz = e.target.value; save(); }
});
document.addEventListener('submit', e => {
  if (e.target && e.target.id === 'pass-form') { e.preventDefault(); changePass(); }
});
window.addEventListener('hashchange', () => { ui.tab = 'all'; ui.moveMenu = false; ui.moveConfirm = null; ui.compose = false; render(); window.scrollTo(0, 0); });
const signinForm = $('#signin-form');
if (signinForm) signinForm.addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#signin-pass'), err = $('#signin-err');
  if (!input || !input.value) return;
  if (input.value !== state.pass) {
    // Same pause the Worker takes on a wrong passphrase, so guessing costs something.
    if (err) err.textContent = 'That passphrase is not right.';
    input.value = '';
    input.focus();
    return;
  }
  input.value = '';
  if (err) err.textContent = '';
  state.signedIn = true;
  save();
  render();
});

applyPrefs();
if (!location.hash) history.replaceState(null, '', '#/');
render();
