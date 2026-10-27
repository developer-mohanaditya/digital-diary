// INK: the served application (the markup lives in index.html).
// Reads the diary from /api/entries, saves a typed note through /api/note, and unlocks with
// the passphrase at /api/session. The design is the demo's: same tokens, cards, chips and
// sheets, all of them from demo/diary.css, so the two pages cannot drift apart.
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
const PREF = 'diary-prefs-v2';
const VIEW = 'diary-view-v1';

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parse = k => { const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const dim = (y, m) => new Date(y, m, 0).getDate();
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let TODAY = iso(new Date()); // replaced by the diary's own today once the API answers

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

/* ---------- The diary itself: what the Worker returns ---------- */
// Today is the diary's today, not the browser's: the Worker files notes by DIARY_TZ, so a
// page in another zone has to ask the same clock which day it is.
const isoIn = (tz) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()); }
  catch (_) { return iso(new Date()); }
};
// Cloudflare bills in neurons, not tokens. A row records what its cleanup spent; the neuron
// figure the dashboard quotes is the estimate made from those tokens.
const neuronsOf = (tin, tout) => +(((tin * 1.1) + (tout * 3.3)) / 220).toFixed(2);
const usageOf = (it) => {
  const u = it.usage || null;
  const tin = (u && u.tokensIn) || 0, tout = (u && u.tokensOut) || 0;
  return { model: (u && u.model) || '', tin, tout, neurons: neuronsOf(tin, tout), known: !!u };
};

// One request fills every page: a year back from today, grouped by day by the Worker.
async function loadDiary() {
  // A day of slack on both ends: the browser and the diary may disagree on which day it is.
  const from = iso(addDays(new Date(), -367)), to = iso(addDays(new Date(), 2));
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { res = await fetch(`/api/entries?from=${from}&to=${to}`); break; }
    catch (_) {
      if (attempt === 2) return { error: 'Could not reach the diary API.' };
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!res) return { error: 'Could not reach the diary API.' };
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401) return { needLogin: true };
  if (!res.ok || !data || !data.ok) return { error: (data && data.error) || `The diary API answered ${res.status}.` };
  if (data.timeZone) { state.tz = data.timeZone; TODAY = isoIn(data.timeZone); }
  const days = {};
  for (const [k, list] of Object.entries(data.days || {})) {
    days[k] = list.map(it => ({ ...it, k, sec: 0, usage: usageOf(it) }));
  }
  state.days = days;
  state.signedIn = true;
  return {};
}

const state = { days:{}, heatmap:'weeks', weekStart:'mon', tz:'', signedIn:false, keys:null, keysLoading:false, keysError:'', newKey:null, keyKind:'read' };
try {
  const v = JSON.parse(localStorage.getItem(VIEW) || '{}') || {};
  if (v.heatmap === 'weeks' || v.heatmap === 'grid') state.heatmap = v.heatmap;
  if (v.weekStart === 'mon' || v.weekStart === 'sun') state.weekStart = v.weekStart;
} catch (_) {}
// The entries belong to the Worker; only the two view choices live in this browser.
const save = () => {
  try { localStorage.setItem(VIEW, JSON.stringify({ heatmap: state.heatmap, weekStart: state.weekStart })); } catch (_) {}
};

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
// Empty font and accent mean "whatever the theme says": the four themes pair a typeface and
// an accent each, and an override is a deliberate departure from that pair, not a default.
const FONTS = [['', 'Theme'], ['grotesk', 'Grotesk'], ['paper', 'Paper serif'], ['system', 'System']];
const FONT_LABEL = Object.fromEntries(FONTS);
const ACCENTS = ['#4338ca', '#c26a3d', '#b7791f', '#0ea5b7', '#c2578a', '#14a37f'];
const CHIPS = [
  ['pills', 'Pills'], ['underline', 'Underline'], ['colorline', 'Colour line'],
  ['dotchips', 'Dot chips'], ['segmented', 'Segmented'], ['dropdown', 'Dropdown'],
];
const CHIP_LABEL = Object.fromEntries(CHIPS);
const DEFAULT_CATS = Object.fromEntries(CATS.map(c => [c.id, c.color]));

const prefs = { theme:'minimal', mode:'light', font:'', accent:'', cats:{}, chips:'pills' };
// A first visit follows the system: the diary is read at night as often as by day, and both
// modes exist for it. A saved choice always wins, so this only decides the first paint.
let prefsSaved = false;
try {
  const raw = localStorage.getItem(PREF);
  if (raw) { Object.assign(prefs, JSON.parse(raw)); prefsSaved = true; }
} catch (_) {}
// The setup page wrote its own key before this page could customise anything. Read it once,
// so a choice made there is not thrown away, then write everything to this page's key and
// never look at the old one again: one store, one place a setting can disagree with itself.
let importedSetup = false;
if (!prefsSaved) {
  try {
    const old = JSON.parse(localStorage.getItem('diary-setup-v1'));
    if (old) {
      if (THEMES.includes(old.theme)) prefs.theme = old.theme;
      if (old.mode === 'light' || old.mode === 'dark') prefs.mode = old.mode;
      if (FONT_LABEL[old.font]) prefs.font = old.font;
      if (ACCENTS.includes(old.accent)) prefs.accent = old.accent;
      if (old.cats && typeof old.cats === 'object') prefs.cats = { ...old.cats };
      if (CHIP_LABEL[old.chips]) prefs.chips = old.chips;
      importedSetup = true;
      prefsSaved = true;
    }
  } catch (_) {}
}
if (!THEMES.includes(prefs.theme)) prefs.theme = 'minimal';
if (!['light', 'dark'].includes(prefs.mode)) prefs.mode = 'light';
if (!prefsSaved && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) prefs.mode = 'dark';
if (!FONT_LABEL[prefs.font]) prefs.font = '';
if (prefs.accent && !ACCENTS.includes(prefs.accent)) prefs.accent = '';
if (!CHIP_LABEL[prefs.chips]) prefs.chips = 'pills';
if (!prefs.cats || typeof prefs.cats !== 'object') prefs.cats = {};

function applyPrefs() {
  document.body.dataset.theme = prefs.theme;
  document.body.dataset.mode = prefs.mode;
  // Both are attributes the stylesheet keys on, so clearing one means removing it rather
  // than setting an empty value the selectors would never match.
  if (prefs.font) document.body.dataset.font = prefs.font;
  else delete document.body.dataset.font;
  if (prefs.accent) document.body.style.setProperty('--accent', prefs.accent);
  else document.body.style.removeProperty('--accent');
  // Category colour is read from this array wherever a dot or chip is painted, so an
  // override is a mutation here, not a rule in the stylesheet.
  CATS.forEach(c => { c.color = prefs.cats[c.id] || DEFAULT_CATS[c.id]; });
  const mb = $('#mode-btn');
  if (mb) {
    mb.innerHTML = prefs.mode === 'light' ? MOON_ICON : SUN_ICON;
    mb.setAttribute('aria-label', prefs.mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  }
}
const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify(prefs)); } catch (_) {} };
if (importedSetup) savePrefs();

const ui = { tab:'all', previewTab:'all', openNote:null, compose:false, busy:false, openRaw:new Set(), dueOpen:false, duePick:'', dueCal:'', addMsg:'', moveMenu:false, moveCat:null, moveDue:'' };

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
  ui.openNote = ref;
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
  if (p[0] === 'settings' && p[1] === 'look') return { view:'look' };
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
function duePill(it) {
  if (it.cat !== 'deadline') return '';
  if (it.done) return `<span class="due done"${it.doneLabel ? ` title="Marked done ${esc(it.doneLabel)}"` : ''}>Done</span>`;
  if (!it.due) return '';
  const n = dueDays(it.due);
  if (n < 0) return `<span class="due over">Overdue ${-n}d</span>`;
  if (n === 0) return '<span class="due soon">Due today</span>';
  if (n === 1) return '<span class="due soon">Due tomorrow</span>';
  return `<span class="due soon">Due in ${n}d</span>`;
}

const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';

// What a deadline is waiting for, stated in days — and the button that ends the waiting.
// A deadline is only done when someone says so, and the note is where they decide; the
// Telegram Done button writes the same row, so the two cannot disagree. The button stays
// afterwards, to reopen a mistake.
function dueLine(it, k) {
  if (it.cat !== 'deadline') return '';
  const when = it.due ? fmtDay(parse(it.due)) : 'No due date';
  const n = it.due ? dueDays(it.due) : null;
  const st = it.done ? (it.doneLabel ? `done ${it.doneLabel}` : 'done')
    : n === null ? '' : n < 0 ? `${-n} days overdue` : n === 0 ? 'due today' : `${n} days left`;
  return `<div class="duline">${duePill(it)}<span class="muted">${esc(when)}${st ? ` · ${st}` : ''}</span>
    <button class="donetog" data-action="due-done" data-v="${k}|${it.id}" aria-pressed="${it.done ? 'true' : 'false'}">${it.done ? 'Reopen' : `${CHECK_ICON}Mark done`}</button></div>`;
}

// The write the page used to leave to the bot. The reminder on the row is what pings, so
// closing it here stops the reminders as well as changing the badge.
async function markDue(ref) {
  const found = ref && findNote(ref);
  if (!found || found.it.cat !== 'deadline') return;
  const next = !found.it.done;
  try {
    const res = await fetch('/api/reminder/done', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: found.it.id, done: next }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      toast((data && data.error) || `The diary API answered ${res.status}.`);
      return;
    }
    await loadDiary();
    render();
    toast(next ? 'Deadline marked done. No more pings.' : 'Deadline reopened. The next ping is tomorrow.');
  } catch (_) {
    toast('Could not reach the diary. Nothing was marked.');
  }
}
const hasRawText = it => it.mode !== 'verbatim' && !!it.raw;

/* ---------- Ledger, sheet ---------- */
// Three doors lead in: the bot, this page, and the API other projects write through. The note
// sheet says which one this note came in by, and an API note is named after the app that filed
// it — "Claude" says something "API" does not. The ledger line stays as it was: a mark on every
// row competes with the note itself, and the note is what the day is for.
const ORIGIN_LABEL = { telegram: 'Telegram', web: 'Web', api: 'API' };
const CLIENT_LABEL = {
  'claude-code': 'Claude', claude: 'Claude', codex: 'Codex', chatgpt: 'ChatGPT',
  'chat-gpt': 'ChatGPT', freebuff: 'Freebuff', cursor: 'Cursor',
};
// A client the diary has not seen before still reads as a name rather than a blank: the capture
// stores what the app called itself, and a new one must not lose its mark for being new.
function originLabel(o) {
  if (!o) return '';
  const source = String(o.source || '').toLowerCase();
  if (source !== 'api') return ORIGIN_LABEL[source] || '';
  const client = String(o.client || '').toLowerCase().trim();
  if (CLIENT_LABEL[client]) return CLIENT_LABEL[client];
  const words = client.replace(/[-_]+/g, ' ').trim();
  return words ? words.replace(/\b\w/g, ch => ch.toUpperCase()) : ORIGIN_LABEL.api;
}
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
  const u = it.usage;
  // A verbatim note never went to a model, and a note saved before the usage columns existed
  // was never measured. Both say so, which is true of either, instead of claiming a cost of
  // zero for one and a model that never ran for the other.
  const cost = u.known
    ? `${u.neurons} neurons · ${u.tin.toLocaleString()} in / ${u.tout.toLocaleString()} out tokens${u.model ? ` · <span class="mid">${esc(u.model.replace('@cf/', ''))}</span>` : ''}`
    : 'No cleanup cost was recorded for this note.';
  return `<div class="overlay"><div class="backdrop" data-action="close-note"></div>
    <div class="sheet nsheet" role="dialog" aria-modal="true" aria-label="Note">
      <div class="shead"><span class="sdot" style="background:${c.color}"></span><strong>${c.label}</strong><span class="mode">${MODE_LABEL[it.mode]}</span><span class="spacer"></span>${hasRaw ? `<button class="hbtn" data-action="raw" data-v="${it.id}" aria-pressed="${rawOpen}" title="${rawOpen ? 'Hide raw' : 'Show raw'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/></svg></button>` : ''}<button class="hbtn" data-action="move-menu" aria-expanded="${ui.moveMenu}" title="Move to another category"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14l3 3 3-3"/></svg></button><button class="xbtn" data-action="close-note" aria-label="Close">\u00d7</button></div>
      ${ui.moveMenu ? moveMenuHTML(it) : ''}
      <div class="sbody">
        <div class="smeta">${fmtDay(parse(k))}<i>·</i>${it.time}<i>·</i>${it.src === 'tag' ? 'Tagged by you' : it.src === 'manual' ? 'Moved by you' : 'Auto filed'}${it.origin ? `<i>·</i>via ${esc(originLabel(it.origin))}` : ''}</div>
        ${dueLine(it, k)}
        ${noteTitleBody(it.text)}
        ${rawOpen && hasRaw ? `<div class="sraw"><span class="kicker">Raw</span><p>${esc(it.raw)}</p></div>` : ''}
      </div>
      <div class="sfoot"><span class="cost">${cost}</span></div>
    </div></div>`;
}

// The move menu: the note's categories, then a yes/no confirm — and a due date when the target
// is Deadline, because a deadline without one is only half a move.
function moveMenuHTML(it) {
  if (!ui.moveCat) {
    return `<div class="mmenu" role="menu">${CATS.map(x =>
      `<button type="button" role="menuitemradio" aria-checked="${x.id === it.cat}" data-action="move-to" data-v="${x.id}"><i style="background:${x.color}"></i>${x.label}</button>`).join('')}</div>`;
  }
  const target = CAT[ui.moveCat];
  const due = ui.moveDue || iso(addDays(new Date(), 7));
  return `<div class="mmenu"><div class="mconf"><span>Move to <b>${target.label}</b>?</span>` +
    (target.id === 'deadline' ? `<label class="mfield"><span>Due</span><input id="move-due" type="date" value="${due}" aria-label="Due date" /></label>` : '') +
    `<span class="row"><button class="btn" data-action="move-yes">Yes</button><button class="btn" data-action="move-no">No</button></span></div></div>`;
}

// The move the demo only pretended to make. The Worker rewrites the row, so the note is in its
// new category on every device and after every reload; a deadline pick then reloads the diary,
// which draws the due badge and the rail entry from the same reminder the bot would have made.
async function moveNote() {
  const found = ui.openNote && findNote(ui.openNote);
  const cat = ui.moveCat;
  if (!found || !cat) return;
  const input = $('#move-due');
  const due = cat === 'deadline' ? ((input && input.value) || ui.moveDue || '') : null;
  if (cat === 'deadline' && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    toast('Pick a due date for the deadline.');
    return;
  }
  try {
    const res = await fetch('/api/note/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: found.it.id, category: cat, due }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      toast((data && data.error) || `The diary API answered ${res.status}.`);
      return;
    }
    ui.moveDue = '';
    await loadDiary();
    ui.moveMenu = false;
    ui.moveCat = null;
    render();
    toast(`Moved to ${CAT[cat].label}${cat === 'deadline' && data.reminder === 'set' ? ' · reminder set' : ''}.`);
  } catch (_) {
    toast('Could not reach the diary. Nothing was moved.');
  }
}

function ledgerHTML(list, k) {
  if (!list.length) return '<p class="muted">Nothing here yet.</p>';
  if (ui.tab !== 'all') return `<div class="ledg">${list.map(it => ledgerRowHTML(it, k)).join('')}</div>`;
  return CATS.filter(c => list.some(it => it.cat === c.id)).map(c => {
    const rows = list.filter(it => it.cat === c.id);
    return `<div class="lgrp"><i class="gdot" style="background:${c.color}"></i>${c.label} <span class="n">(${rows.length})</span></div><div class="ledg">${rows.map(it => ledgerRowHTML(it, k)).join('')}</div>`;
  }).join('');
}
// One renderer, six shapes. The Look page samples exactly this code, so what it shows is
// what the day gets — a picture of the tabs cannot drift from the tabs themselves.
const chipColor = id => (id !== 'all' && CAT[id] ? CAT[id].color : 'var(--accent)');
function tabsHTML(defs, sel, opts = {}) {
  const shape = opts.chips ?? prefs.chips;
  const action = opts.preview ? 'preview-tab' : 'tab';
  const attr = d => `data-action="${action}" data-v="${d.id}"`;
  const role = opts.preview ? '' : ' role="tablist"';
  const tab = opts.preview ? '' : ' role="tab"';
  if (shape === 'underline' || shape === 'colorline') {
    const cls = shape === 'colorline' ? 'utabs colorful' : 'utabs';
    return `<div class="${cls}"${role}>` + defs.map(d =>
      `<button type="button" ${attr(d)}${tab} aria-selected="${sel === d.id}"${shape === 'colorline' ? ` style="--c:${chipColor(d.id)}"` : ''}>${d.label}<sup>${d.n}</sup></button>`).join('') + '</div>';
  }
  if (shape === 'dotchips') {
    return `<div class="ctabs"${role}>` + defs.map(d =>
      `<button type="button" ${attr(d)}${tab} aria-selected="${sel === d.id}" style="--c:${chipColor(d.id)}"><i></i>${d.label}<em>${d.n}</em></button>`).join('') + '</div>';
  }
  if (shape === 'segmented') {
    return `<div class="segbar"${role}>` + defs.map(d =>
      `<button type="button" ${attr(d)}${tab} aria-selected="${sel === d.id}">${d.label}<small> ${d.n}</small></button>`).join('') + '</div>';
  }
  if (shape === 'dropdown') {
    const id = opts.preview ? 'preview-tab-sel' : 'tab-sel';
    return `<div class="dday"><select id="${id}" aria-label="Filter the day by category">` +
      defs.map(d => `<option value="${d.id}"${sel === d.id ? ' selected' : ''}>${d.label} · ${d.n}</option>`).join('') + '</select></div>';
  }
  return `<div class="tabs tabs-inline"${role}>` + defs.map(d =>
    `<button class="tab" ${attr(d)}${tab} aria-selected="${sel === d.id}">${d.label}<small>${d.n}</small></button>`).join('') + '</div>';
}
function dayTabsHTML(defs) {
  return tabsHTML(defs, ui.tab);
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
  // A dash, not a zero: a day of verbatim notes cost nothing, and a day of older notes was
  // never measured. Both read as free if the counter claims 0.
  const known = list.some(it => it.usage.known);
  // Six digits do not fit a phone's counter cell, and the exact figure is one hover away:
  // the cell shows 12.3k, the tooltip keeps 12,345.
  const compact = n => n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString();
  const cards = [
    { n: list.length, label: 'entries', title: `${list.length} ${list.length === 1 ? 'entry' : 'entries'}` },
    { n: cats, label: 'categories', title: `${cats} ${cats === 1 ? 'category' : 'categories'}` },
    { n: known ? compact(tokens) : '—', label: 'tokens', title: known ? `${tokens.toLocaleString()} tokens in and out` : 'No note on this day recorded usage' },
    { n: known ? neurons.toFixed(1) : '—', label: 'neurons', title: known ? `${neurons.toFixed(1)} neurons, estimated` : 'No note on this day recorded usage' },
  ];
  return `<div class="hstats">${cards.map(c =>
    `<div class="hstat" title="${esc(c.title)}"><b>${c.n}</b><span>${c.label}</span></div>`).join('')}</div>`;
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

// An empty deadlines card is not worth a phone's scroll, so it steps aside there and keeps
// its place on the web, saying so in one line.
function dueCard() {
  const open = openDeadlines();
  const overdue = open.filter(it => dueDays(it.due) < 0).length;
  return `<section class="card railcard${open.length ? '' : ' dueempty'}">
    <div class="lhead" style="margin-bottom:4px;align-items:flex-start">
      <div><span class="kicker">Deadlines</span><h2 style="margin:2px 0 0">Due</h2></div>${open.length
      ? `<span class="due ${overdue ? 'over' : 'soon'}">${overdue ? `${overdue} overdue` : `${open.length} open`}</span>` : ''}</div>
    ${open.length ? open.slice(0, 5).map(it => `<div class="lrow clickable" data-action="open" data-v="${it.k}|${it.id}" tabindex="0" role="button" title="Open note">
        <span class="ltxt"><b class="clampb">${esc(plainText(it.text))}</b><span class="muted" style="font-size:.76rem">${fmtShort2y(it.due)} · ${CAT[it.cat].label}</span></span>${duePill(it)}
      </div>`).join('')
      : '<p class="muted" style="margin:0">Nothing due.</p>'}
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
      <p class="chint">Filed into today by the Worker's clock. The cleanup runs on save; the category is only a guess, and you can file it under Deadline to give it a due date.</p>
      <textarea id="add-text" placeholder="Type a thought, quote or note…" aria-label="Note text"></textarea>
      <div class="addmsg" id="add-msg" role="status" aria-live="polite">${esc(ui.addMsg || '')}</div>
      <div class="crow">
        <select id="add-mode" aria-label="Cleanup mode"><option value="refined">Refined</option><option value="verbatim">Verbatim</option><option value="reason">Reason</option><option value="think">Think</option></select>
        <select id="add-cat" aria-label="Category"><option value="">Auto (Inbox for now)</option>${CATS.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}</select>
        <span class="duewrap" id="due-wrap" hidden>
          <button class="btn duebtn" type="button" data-action="due-toggle" aria-expanded="${ui.dueOpen}" aria-controls="due-panel" title="Pick a due date">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
            <span id="due-label">${ui.duePick ? esc(fmtDue(ui.duePick)) : 'Due date'}</span></button>
        </span>
        <span class="spacer"></span>
        <button class="btn csave" data-action="add"${ui.busy ? ' disabled' : ''}>${ui.busy ? 'Saving…' : 'Add note'}</button>
      </div>
      <div class="duebox" id="due-panel" aria-label="Pick a due date"${ui.dueOpen ? '' : ' hidden'}></div>
      <p class="chint">\u2318\u21b5 adds it. Esc closes. A due date is only read for the Deadline category.</p>
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
  // Only a note whose cleanup ran has a record. Summing the rest as zero would draw a month
  // of free AI, so the card says how many notes it is actually summing.
  const known = list.filter(it => it.usage.known);
  const openDl = Object.values(state.days).flat().filter(it => it.cat === 'deadline' && !it.done).length;
  const byModel = {};
  known.forEach(it => {
    const name = it.usage.model || 'not recorded';
    const mm = (byModel[name] = byModel[name] || { calls:0, tin:0, tout:0, neurons:0 });
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
      <p class="note">${known.length
        ? `${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out tokens across ${known.length} ${known.length === 1 ? 'note' : 'notes'} · ${(neurons / known.length).toFixed(2)} per note.`
        : `None of the ${list.length} ${list.length === 1 ? 'note' : 'notes'} in this range recorded what its cleanup cost, so there is nothing to add up yet.`}</p>
      ${known.length ? `<table class="models">
        <thead><tr><th>Model</th><th class="num">Notes</th><th class="num">Tokens</th><th class="num">Neurons</th></tr></thead>
        <tbody>${Object.entries(byModel).sort((a, b) => b[1].neurons - a[1].neurons).map(([model, v]) =>
          `<tr><td>${esc(model.replace('@cf/', ''))}</td><td class="num">${v.calls}</td><td class="num">${(v.tin + v.tout).toLocaleString()}</td><td class="num">${v.neurons.toFixed(1)}</td></tr>`).join('')}</tbody>
      </table>` : ''}
      <p class="note">Estimated from the tokens each cleanup recorded. A verbatim note never reaches a model, and a note saved before the usage columns existed has no record.</p>
    </div>
    ${pick}
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Recent notes</span>${recentLink}</div>
    <h2>Newest first, with what each cost</h2>
    ${recent.length ? recent.map(it => `<div class="lrow clickable" data-action="open" data-v="${it.k}|${it.id}" tabindex="0" role="button" title="Open note">
      <span class="ltime${isYear ? ' wide' : ''}">${isYear ? fmtShort2y(it.k) : +it.k.slice(8)} ${it.time}</span>
      <span class="ltxt clamp"><i class="dot" style="background:${CAT[it.cat].color}"></i>${esc(plainText(it.text))}</span>
      <span class="cost">${it.usage.known ? `${it.usage.neurons} n · ${it.usage.tin + it.usage.tout} tok` : 'no usage record'}</span>
    </div>`).join('') : `<p class="muted">Nothing in ${scope} yet.</p>`}
  </section>`;
}

/* ---------- Settings ---------- */
function viewSettings() {
  const total = Object.values(state.days).reduce((a, list) => a + list.length, 0);
  const written = Object.keys(state.days).length;
  return `
  <section class="hero sethead">
    <div>
      <span class="kicker">Settings</span><h1>Preferences</h1>
      <p class="muted" style="margin:0">How the diary looks, how the month is drawn, and where its entries come from.</p>
    </div>
  </section>
  <section class="card">
    <div class="setrow"><div><span class="lab">Look</span><span class="sub">${lookSummary()}</span></div>
      <a class="microbtn" href="#/settings/look">More customization →</a></div>
    <div class="setrow"><div><span class="lab">Month heatmap</span><span class="sub">Both shapes are here; this picks the default</span></div>
      <div class="seg"><button data-action="heatmap" data-v="weeks" aria-pressed="${state.heatmap === 'weeks'}">Weeks table</button><button data-action="heatmap" data-v="grid" aria-pressed="${state.heatmap === 'grid'}">Calendar grid</button></div></div>
    <div class="setrow"><div><span class="lab">Week starts</span><span class="sub">Applied to both month views</span></div>
      <select id="set-week"><option value="mon"${state.weekStart === 'mon' ? ' selected' : ''}>Monday</option><option value="sun"${state.weekStart === 'sun' ? ' selected' : ''}>Sunday</option></select></div>
    <div class="setrow"><div><span class="lab">Timezone</span><span class="sub">Decides which day a note belongs to; set by DIARY_TZ on the Worker</span></div>
      <span class="muted" style="font-size:.84rem;font-family:ui-monospace,monospace">${esc(state.tz || 'not reported')}</span></div>
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Entries</span></div>
    <h2>${total.toLocaleString()} ${total === 1 ? 'note' : 'notes'} over ${written.toLocaleString()} ${written === 1 ? 'day' : 'days'}</h2>
    <p class="muted" style="margin:0;font-size:.84rem">Read live from the database, a year back. Notes arrive here from Telegram and from this page; the passphrase is checked by the Worker, never kept in this browser.</p>
    <div class="crow"><button class="btn" data-action="refresh">Reload the diary</button></div>
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Access</span><span class="muted" style="font-size:.76rem">/api/v1</span></div>
    <div class="setrow"><div><span class="lab">Which kind of key</span><span class="sub">A read key pulls notes out; a write key files notes in. They are separate keys</span></div>
      <div class="seg"><button data-action="key-kind" data-v="read" aria-pressed="${state.keyKind === 'read'}">Read keys</button><button data-action="key-kind" data-v="write" aria-pressed="${state.keyKind === 'write'}">Write keys</button></div></div>
    <h2>${state.keyKind === 'write' ? 'Write keys' : 'Read keys'}</h2>
    <p class="muted" style="margin:0 0 2px;font-size:.84rem">${state.keyKind === 'write'
      ? 'An app files notes into this diary with a write key: one note, or a whole session in one request, and the receipt comes back on Telegram. The limits below work in the other direction — which categories it may write into, and which dates — and a write key cannot read a single note back. This is the key to give Claude Code, Codex, or anything else that should write and nothing more.'
      : 'Any other project reads this diary with a key: notes by day, month, year, category or type, every deadline, and the counts. Give every project its own key, and set its limits as you create it: which categories, which dates, and whether it may read the text at all. A key that leaks then exposes only the slice it was given.'}</p>
    ${keysHTML()}
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Access</span></div>
    <h2>Change the passphrase</h2>
    <form class="passform" id="pass-form" autocomplete="off">
      <label class="field"><span>Current passphrase</span><input id="pass-cur" type="password" autocomplete="current-password" /></label>
      <label class="field"><span>New passphrase</span><input id="pass-new" type="password" autocomplete="new-password" /></label>
      <label class="field"><span>Repeat the new one</span><input id="pass-rep" type="password" autocomplete="new-password" /></label>
      <div class="passrow">
        <button class="cbtn" type="submit" id="pass-save">Save the new passphrase</button>
        <span class="pmsg" id="pass-msg" role="status" aria-live="polite"></span>
      </div>
    </form>
    <p class="note">Eight characters or more. The Worker keeps a hash of it, never the phrase itself; saving one signs out every other device and keeps this one in.</p>
  </section>`;
}

// Changing the passphrase. The Worker verifies the current one and writes a fresh hash, so this
// form works without a Cloudflare dashboard visit; what it cannot do is recover a forgotten
// passphrase, because nothing anywhere keeps the words.
async function changePassphrase() {
  const cur = $('#pass-cur'), nw = $('#pass-new'), rp = $('#pass-rep'), msg = $('#pass-msg'), btn = $('#pass-save');
  if (!cur || !nw || !rp) return;
  const fail = (text, el) => {
    [cur, nw, rp].forEach(i => i.removeAttribute('aria-invalid'));
    if (el) { el.setAttribute('aria-invalid', 'true'); el.focus(); }
    if (msg) { msg.textContent = text; msg.className = 'pmsg err'; }
  };
  if (!cur.value) return fail('Type the passphrase you have now.', cur);
  if (nw.value.length < 8) return fail('Use at least eight characters.', nw);
  if (nw.value !== rp.value) return fail('The two new ones do not match.', rp);
  if (nw.value === cur.value) return fail('That is the passphrase you already have.', nw);
  if (btn) btn.disabled = true;
  let data = null, status = 0;
  try {
    const res = await fetch('/api/passphrase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: cur.value, next: nw.value }),
    });
    status = res.status;
    data = await res.json().catch(() => null);
  } catch (_) {
    if (btn) btn.disabled = false;
    fail('Could not reach the diary. Nothing changed.', null);
    return;
  }
  if (btn) btn.disabled = false;
  if (!data || !data.ok) {
    // A 401 here means the cookie went stale while the page sat open, so the gate is the
    // honest answer; every other refusal belongs beside the field it is about.
    if (status === 401) { showSignin('Sign in again to change the passphrase.'); return; }
    const text = (data && data.error) || `The Worker answered ${status}.`;
    fail(text, /current/i.test(text) ? cur : nw);
    return;
  }
  cur.value = ''; nw.value = ''; rp.value = '';
  [cur, nw, rp].forEach(i => i.removeAttribute('aria-invalid'));
  if (msg) { msg.textContent = 'Saved. It is the only passphrase that opens this diary now.'; msg.className = 'pmsg ok'; }
  toast('Passphrase changed.');
}

/* ---------- API keys ---------- */
// Other projects read the diary with a key minted here. The secret exists on this page once,
// between the answer that created it and the moment the panel is dismissed: the list keeps
// only the prefix, and the database keeps only a hash, so there is nothing to read back.
const SCOPE_UI = [
  ['notes:read', 'Notes'],
  ['deadlines:read', 'Deadlines'],
  ['stats:read', 'Counts'],
  ['raw:read', 'Original text'],
];
// notes:write is not in the list above because it is not a read scope: a write key is created
// in the Write keys half of this card, and the label is here so a row can still name it.
const SCOPE_LABEL = { ...Object.fromEntries(SCOPE_UI.map(([id, label]) => [id, label])), 'notes:write': 'Add notes' };
const isWriteKey = k => (k.scopes || []).includes('notes:write');
const keyWhen = ts => new Date(ts).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
const keyDay = d => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
const keyscopes = () => SCOPE_UI.map(([id, label]) => `<label><input type="checkbox" data-scope="${id}"${id === 'raw:read' ? '' : ' checked'} />${label}</label>`).join('');
const keycats = () => CATS.map(c => `<label><input type="checkbox" data-cat="${c.id}" checked />${c.label}</label>`).join('');

// A key's limits in the words the form used to set them, so the row can be read at a glance:
// "work, project · since 1 Jan 2026 · counts only".
function policyWords(p) {
  if (!p) return 'limits could not be read — this key is refused';
  const cats = p.categories ? p.categories.map(c => (CAT[c] ? CAT[c].label : c)).join(', ') : 'every category';
  const days = p.from && p.to ? `${keyDay(p.from)} – ${keyDay(p.to)}`
    : p.from ? `since ${keyDay(p.from)}`
    : p.to ? `until ${keyDay(p.to)}`
    : 'any day';
  return `${cats} · ${days} · ${p.text === 'none' ? 'counts only, no note text' : 'full text'}`;
}

function keysHTML() {
  if (state.newKey) {
    const k = state.newKey;
    const expires = k.expiresAt ? `Expires ${keyWhen(k.expiresAt)}.` : 'It does not expire.';
    // Where the key belongs, which is the question the one-time panel exists to answer.
    const where = isWriteKey(k)
      ? 'Put it in the app\u2019s environment as DIARY_API_KEY \u2014 the MCP server and the /diary command both read it from there.'
      : 'Put it in the other project\u2019s environment secrets, never in a browser bundle.';
    return `<div class="keyonce">
      <span class="lab">Your new key — copy it now</span>
      <div class="keyline">
        <input class="keymono" id="key-value" readonly value="${esc(k.key)}" aria-label="New API key" />
        <button class="cbtn" data-action="key-copy">Copy</button>
      </div>
      <p class="note" style="margin-top:8px">${esc(k.name)} · ${k.scopes.map(s => esc(SCOPE_LABEL[s] || s)).join(' · ')}. ${esc(policyWords(k.policy))}. ${expires}
        ${k.perMinute && k.perDay ? (isWriteKey(k)
          ? `Up to ${k.perMinute} notes a minute and ${k.perDay} a day: every note spends one, not every request. Each one is confirmed on Telegram, and a caller cannot switch that off. `
          : `Up to ${k.perMinute} requests a minute, ${k.perDay} a day. `) : ''}
        This is the only time it is shown: the diary keeps a hash, so it cannot be read back.
        ${where}</p>
      <div class="passrow" style="margin-top:10px"><button class="btn" data-action="key-done">Done</button></div>
    </div>`;
  }

  // Only one kind is on screen at a time, because the two are created with different fields
  // and mean different things; the segment above picks which half of the card is open.
  const write = state.keyKind === 'write';
  const shown = Array.isArray(state.keys) ? state.keys.filter(k => isWriteKey(k) === write) : null;
  const rows = state.keys === null
    ? '<p class="muted" style="font-size:.84rem;margin:14px 0 0">Reading the keys…</p>'
    : state.keysError
      ? `<p class="pmsg err" style="margin:14px 0 0">${esc(state.keysError)} <button class="link" data-action="keys-retry">Try again</button></p>`
      : shown.length
        ? `<div style="margin-top:6px">${shown.map(k => {
            const expired = k.expiresAt && Date.parse(k.expiresAt) <= Date.now();
            const pill = k.revokedAt || expired ? 'off' : 'live';
            const when = k.revokedAt ? `revoked ${keyWhen(k.revokedAt)}`
              : expired ? `expired ${keyWhen(k.expiresAt)}`
              : k.lastUsedAt ? `used ${keyWhen(k.lastUsedAt)}`
              : 'never used';
            return `<div class="setrow keyrow">
              <div style="min-width:0">
                <span class="lab">${esc(k.name)} <span class="keypill ${pill}">${k.revokedAt ? 'revoked' : expired ? 'expired' : 'live'}</span></span>
                <span class="sub"><code>${esc(k.prefix)}…</code> · ${k.scopes.map(s => esc(SCOPE_LABEL[s] || s)).join(' · ')} · ${when}${k.perMinute && k.perDay ? ` · ${k.perMinute}/min, ${k.perDay}/day` : ''}</span>
                <span class="keypolicy">${esc(policyWords(k.policy))}</span>
              </div>
              ${k.revokedAt ? '' : `<button class="microbtn danger" data-action="key-revoke" data-v="${esc(k.id)}" data-name="${esc(k.name)}">Revoke</button>`}
            </div>`;
          }).join('')}</div>`
        : `<p class="muted" style="font-size:.84rem;margin:14px 0 0">${write ? 'No write keys yet. One per app, so revoking it stops that app and nothing else.' : 'No keys yet. One key per project keeps a leak down to one revoke.'}</p>`;

  return `${rows}
    <form class="keyform" id="key-form" autocomplete="off">
      <label class="field"><span>Name</span><input id="key-name" maxlength="60" placeholder="${write ? 'Claude Code' : 'Portfolio site'}" /></label>
      <label class="field"><span>Expires</span><select id="key-exp">
        <option value="90">in 90 days</option><option value="365">in a year</option><option value="never">never</option>
      </select></label>
      ${write ? '' : `<div class="keyscopes">${keyscopes()}</div>`}
      <div class="keylimits">
        <span class="klab">Categories it may ${write ? 'write into' : 'read'}</span>
        <div class="keyscopes">${keycats()}</div>
      </div>
      <label class="field"><span>Notes ${write ? 'dated from' : 'written since'}</span><input type="date" id="key-from" /></label>
      <label class="field"><span>Notes ${write ? 'dated until' : 'written until'}</span><input type="date" id="key-to" /></label>
      ${write ? '' : `<label class="field keywide"><span>Note text</span><select id="key-text">
        <option value="clean">Full text — the notes themselves</option>
        <option value="none">Counts only — days, categories and word counts, no sentences</option>
      </select></label>`}
      <p class="keyhint">${write
        ? 'This key may add notes and nothing else: reading is refused, whatever the fields above say. Leave every category ticked and the dates empty for one that may file anything, on any day.'
        : 'Limits are enforced on every read. Leave the dates empty for any day and keep every category ticked for the whole diary.'}</p>
      <div class="passrow"><button class="cbtn" type="submit" id="key-create">Create ${write ? 'a write key' : 'a key'}</button><span class="pmsg" id="key-msg" role="status" aria-live="polite"></span></div>
    </form>`;
}

// The list is read once per visit to Settings, not on every render: render() runs on every
// click and key rows do not change while a note is being filed.
function ensureKeys() {
  if (state.keys !== null || state.keysLoading) return;
  state.keysLoading = true;
  (async () => {
    try {
      const res = await fetch('/api/keys');
      const data = await res.json().catch(() => null);
      if (res.status === 401) { state.keysLoading = false; showSignin('Sign in to manage API keys.'); return; }
      if (!data || !data.ok) { state.keys = []; state.keysError = (data && data.error) || `The diary answered ${res.status}.`; }
      else { state.keys = data.keys; state.keysError = ''; }
    } catch (_) {
      state.keys = [];
      state.keysError = 'Could not reach the diary.';
    }
    state.keysLoading = false;
    render();
  })();
}

async function createKey() {
  const write = state.keyKind === 'write';
  const nameEl = $('#key-name'), expEl = $('#key-exp'), msg = $('#key-msg'), btn = $('#key-create');
  const name = nameEl ? nameEl.value.trim() : '';
  const fail = text => { if (msg) { msg.textContent = text; msg.className = 'pmsg err'; } };
  if (!name) { fail('Give the key a name, so you know which app or project holds it.'); if (nameEl) nameEl.focus(); return; }

  // A write key is created with the one scope that door opens and nothing else: that it cannot
  // read is the whole point of giving one to an app. The read half keeps its own checks.
  let scopes = ['notes:write'];
  let text = 'clean';
  if (!write) {
    scopes = Array.from(document.querySelectorAll('.keyform input[data-scope]')).filter(i => i.checked).map(i => i.dataset.scope);
    if (!scopes.length) return fail('Pick at least one scope.');
    if (scopes.includes('raw:read') && !scopes.includes('notes:read')) {
      return fail('Original text is read through notes, so tick Notes too.');
    }
    const textEl = $('#key-text');
    text = textEl ? textEl.value : 'clean';
    if (text === 'none' && scopes.includes('raw:read')) {
      return fail('Counts-only keys cannot read original text, so untick Original text.');
    }
  }

  const catBoxes = Array.from(document.querySelectorAll('.keyform input[data-cat]'));
  const cats = catBoxes.filter(i => i.checked).map(i => i.dataset.cat);
  if (catBoxes.length && !cats.length) return fail('Pick at least one category, or tick them all for every one.');
  const fromEl = $('#key-from'), toEl = $('#key-to');
  const from = fromEl && fromEl.value ? fromEl.value : null;
  const to = toEl && toEl.value ? toEl.value : null;
  if (from && to && from > to) return fail('The window ends before it starts.');
  const policy = {
    categories: catBoxes.length && cats.length < catBoxes.length ? cats : null,
    from, to, text,
  };
  if (btn) btn.disabled = true;
  let data = null, status = 0;
  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scopes, expiresInDays: expEl ? expEl.value : 'never', policy }),
    });
    status = res.status;
    data = await res.json().catch(() => null);
  } catch (_) {
    if (btn) btn.disabled = false;
    return fail('Could not reach the diary. Nothing was created.');
  }
  if (btn) btn.disabled = false;
  if (status === 401) { showSignin('Sign in again to create a key.'); return; }
  if (!data || !data.ok) return fail((data && data.error) || `The diary answered ${status}.`);
  state.newKey = data;
  // The new key belongs in the list behind the reveal, so the next visit reads it fresh.
  state.keys = null;
  render();
}

async function copyKey() {
  const field = $('#key-value');
  if (!field) return;
  try {
    await navigator.clipboard.writeText(field.value);
    toast('Key copied.');
  } catch (_) {
    // Clipboard permission is not guaranteed on a plain origin; selecting the text is the
    // fallback that still lets the key be copied by hand.
    field.focus();
    field.select();
    toast('Press Ctrl/Cmd + C to copy the key.');
  }
}

async function revokeKey(id) {
  const row = document.querySelector(`[data-action="key-revoke"][data-v="${id}"]`);
  const name = row && row.dataset.name ? row.dataset.name : 'this key';
  if (!window.confirm(`Revoke ${name}? Any project using it stops reading the diary at once.`)) return;
  try {
    const res = await fetch(`/api/keys/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (res.status === 401) { showSignin('Sign in again to revoke a key.'); return; }
    if (!data || !data.ok) { toast((data && data.error) || `The diary answered ${res.status}.`); return; }
    toast('Key revoked.');
    state.keys = null;
    state.keysLoading = false;
    ensureKeys();
  } catch (_) {
    toast('Could not reach the diary. Nothing was revoked.');
  }
}

// The one line Settings shows for everything the Look page holds. The font name is the one
// in effect, not the stored override: "Theme" on its own would tell you nothing.
const themeFont = () => (prefs.theme === 'paper' ? 'paper' : 'grotesk');
function lookSummary() {
  return `${THEME_LABEL[prefs.theme]} · ${prefs.mode === 'light' ? 'Light' : 'Dark'} · ${FONT_LABEL[prefs.font || themeFont()]} · ${CHIP_LABEL[prefs.chips]}`;
}

// The Look page. It owns every visual choice, so Settings can stay a list of facts and a
// way back; the day's tab shape is sampled here with the renderer the day itself uses.
const LOOK_SAMPLE = [
  { id:'all', label:'All', n:7 },
  { id:'learning', label:'Learning', n:3 },
  { id:'work', label:'Work', n:2 },
  { id:'life', label:'Life', n:1 },
];
function viewLook() {
  return `
  <section class="hero sethead">
    <div>
      <span class="kicker">Look</span><h1>Appearance</h1>
      <p class="muted" style="margin:0">Theme, type, colour, and the shape of the day's filters. Every change lands on the whole diary as you make it.</p>
    </div>
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Theme and type</span></div>
    <div class="setrow"><div><span class="lab">Theme</span><span class="sub">Each one pairs a typeface with an accent</span></div>
      <div class="seg">${THEMES.map(t => `<button data-action="theme-set" data-v="${t}" aria-pressed="${prefs.theme === t}">${THEME_LABEL[t]}</button>`).join('')}</div></div>
    <div class="setrow"><div><span class="lab">Mode</span><span class="sub">Light or dark, for every theme</span></div>
      <div class="seg"><button data-action="mode-set" data-v="light" aria-pressed="${prefs.mode === 'light'}">Light</button><button data-action="mode-set" data-v="dark" aria-pressed="${prefs.mode === 'dark'}">Dark</button></div></div>
    <div class="setrow"><div><span class="lab">Font</span><span class="sub">Theme default unless you pick one</span></div>
      <div class="seg">${FONTS.map(([v, label]) => `<button data-action="look-font" data-v="${v}" aria-pressed="${prefs.font === v}">${label}</button>`).join('')}</div></div>
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Colour</span></div>
    <div class="setrow"><div><span class="lab">Accent</span><span class="sub">Buttons, links, charts and the heatmap</span></div>
      <div class="accentrow">
        <button class="autoacc" data-action="look-accent" data-v="" aria-pressed="${!prefs.accent}">Theme</button>
        ${ACCENTS.map(a => `<button class="sw" data-action="look-accent" data-v="${a}" aria-pressed="${prefs.accent === a}" aria-label="Accent ${a}" title="${a}"><span style="background:${a}"></span></button>`).join('')}
      </div></div>
    <div class="cathead"><span class="lab">Category colours</span><span class="sub">One dot per category, wherever it appears</span></div>
    <div class="catgrid">${CATS.map(c => `
      <label class="catrow"><i style="background:${c.color}"></i><span>${c.label}</span>
        <input type="color" data-cat="${c.id}" value="${prefs.cats[c.id] || DEFAULT_CATS[c.id]}" aria-label="${c.label} colour" /></label>`).join('')}</div>
    <button class="lookreset" data-action="look-reset">Reset the whole look to the theme defaults</button>
  </section>

  <section class="card">
    <div class="lhead"><span class="kicker">Category filters</span></div>
    <h2>How the day's tabs are drawn</h2>
    <p class="muted" style="margin:0 0 2px;font-size:.84rem">Six shapes, one job. The sample is live — click a category in it.</p>
    <div class="tabpreview" id="tabpreview">${tabsHTML(LOOK_SAMPLE, ui.previewTab, { chips: prefs.chips, preview: true })}</div>
    <div class="chipset">${CHIPS.map(([v, label]) => `<button class="chipopt" data-action="look-chips" data-v="${v}" aria-pressed="${prefs.chips === v}">${label}</button>`).join('')}</div>
  </section>`;
}


/* ---------- Crumbs + render ---------- */
const iconSVG = (body, attrs = '') => `<svg ${attrs}viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const DASH_ICON = iconSVG('<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>');
const HOME_BODY = '<path d="M3.4 10.5 12 3.4l8.6 7.1"/><path d="M5.6 9.4V20a.6.6 0 0 0 .6.6h4.2v-5.5h3.2v5.5h4.2a.6.6 0 0 0 .6-.6V9.4"/>';
const HOME_ICON = iconSVG(HOME_BODY);
// Home's own mark in the breadcrumb: the bar's house, drawn the way the bar draws every icon
// (one 1.8 stroke, round joins, no fill), in the page's ink since it sits on the page.
const HOME_CRUMB = iconSVG(HOME_BODY, 'role="img" aria-label="Home" ');
// Signing out is an account action, not a page heading, so it rides at the trail's right end
// on every width rather than overhanging the card it used to float above.
const SIGNOUT_ICON = iconSVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>', 'aria-hidden="true" ');
const SIGNOUT_BTN = `<button class="dangerbtn" data-action="signout" title="Locks the diary until the passphrase is entered again">${SIGNOUT_ICON}<span>Sign out</span></button>`;

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
  if (r.view === 'look') trail += '<span class="sep">/</span><a href="#/settings">Settings</a><span class="sep">/</span><span aria-current="page">Look</span>';
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
  c.classList.toggle('crumb-home', r.view === 'home');
  // Every day carries the plus, not just today: a phone has no `n` key, and "I remembered
  // something from yesterday" should not need a trip back to today first. The way back is
  // already the trail's Home link, so the fifth cell is spent on writing.
  tools.classList.toggle('cells', isDay);
  tools.innerHTML = isDay
    ? `${statCardsHTML(k)}<button class="newbtn" data-action="compose" title="New note (n)" aria-label="New note">${PLUS_ICON}<span>New note</span></button>`
    : r.view === 'settings' ? SIGNOUT_BTN
    : r.view === 'look' ? '<a class="microbtn" href="#/settings">Done →</a>'
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
  // Settings reads the key list the first time it is opened, then remembers it.
  if (r.view === 'settings') ensureKeys();
  syncNav(r);
  renderCrumbs(r);
  const t = parse(TODAY);
  appEl.innerHTML =
    r.view === 'year' ? statsPage(r.y) :
    r.view === 'settings' ? viewSettings() :
    r.view === 'look' ? viewLook() :
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

/* ---------- Composer: a note typed on the page ---------- */
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// The due picker sits in the sheet's own flow. A calendar in a popover inside a sheet that
// scrolls is a calendar half off the screen on a phone, and this one is only ever opened on
// purpose.
const isDeadlinePicked = () => { const s = $('#add-cat'); return !!s && s.value === 'deadline'; };
function dueCalHTML() {
  const [yy, mm] = ui.dueCal.split('-').map(Number);
  const lead = (new Date(yy, mm - 1, 1).getDay() + 6) % 7;
  let cells = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(x => `<span class="dow">${x}</span>`).join('');
  for (let i = 0; i < lead; i++) cells += '<span></span>';
  for (let d = 1; d <= dim(yy, mm); d++) {
    const k = `${yy}-${pad(mm)}-${pad(d)}`;
    const cls = k === ui.duePick ? 'sel' : k === TODAY ? 'today' : '';
    cells += `<button type="button" class="dbtn ${cls}" data-action="due-day" data-v="${k}">${d}</button>`;
  }
  return `<div class="dhead"><button type="button" class="btn" data-action="due-prev" aria-label="Previous month">‹</button><strong>${MONTHS[mm - 1]} ${yy}</strong><button type="button" class="btn" data-action="due-next" aria-label="Next month">›</button></div><div class="dgrid">${cells}</div><div class="dfoot"><button type="button" class="link" data-action="due-today">Today</button><button type="button" class="link" data-action="due-clear">Clear</button></div>`;
}
// Patching the panel in place, not re-rendering the page: a full render would rebuild the
// textarea and take the note that is being typed with it.
function renderDuePanel() {
  const wrap = $('#due-wrap');
  const box = $('#due-panel');
  const show = isDeadlinePicked();
  if (wrap) wrap.hidden = !show;
  if (box) {
    box.hidden = !(show && ui.dueOpen);
    box.innerHTML = box.hidden ? '' : dueCalHTML();
  }
  const btn = document.querySelector('[data-action="due-toggle"]');
  if (btn) btn.setAttribute('aria-expanded', String(ui.dueOpen));
  const lab = $('#due-label');
  if (lab) lab.textContent = ui.duePick ? fmtDue(ui.duePick) : 'Due date';
}
function setDuePick(v) { ui.duePick = v || ''; renderDuePanel(); }
function shiftDueCal(n) {
  const [yy, mm] = ui.dueCal.split('-').map(Number);
  const d = new Date(yy, mm - 1 + n, 1);
  ui.dueCal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

// A note typed here takes the same path as a Telegram message: the Worker stores it, runs the
// cleanup, writes the reminder if it is a deadline, and answers what it did. The page then
// reloads, so what stays on screen is the row in the database, not an optimistic copy of it.
async function addEntry() {
  const box = $('#add-text');
  const text = box ? box.value.trim() : '';
  if (!text) { ui.addMsg = 'Write something first.'; render(); return; }
  const catEl = $('#add-cat'), modeEl = $('#add-mode');
  const cat = (catEl && catEl.value) || null;
  const mode = (modeEl && modeEl.value) || 'refined';
  const due = cat === 'deadline' ? (ui.duePick || iso(addDays(new Date(), 7))) : null;
  ui.busy = true;
  ui.addMsg = 'Saving…';
  render();
  try {
    const res = await fetch('/api/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 'refined' is the page's word for it; the Worker's command for it is 'refine'.
      body: JSON.stringify({ text, mode: mode === 'refined' ? 'refine' : mode, category: cat, due }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      ui.busy = false;
      ui.addMsg = (data && data.error) || `The diary API answered ${res.status}.`;
      render();
      return;
    }
    const loaded = await loadDiary();
    ui.busy = false;
    ui.compose = false;
    ui.duePick = '';
    ui.dueOpen = false;
    ui.addMsg = '';
    render();
    toast(data.cleanup === 'verbatim' ? 'Saved as written.'
      : data.cleanup === 'formatted' ? 'Saved and formatted.'
      : data.cleanup === 'unchanged' ? 'Saved. The cleanup found nothing to change.'
      : `Saved. The cleanup did not run${data.error ? ` (${data.error})` : ''}.`);
    if (loaded.error) toast(`Saved, but reloading the page failed: ${loaded.error}`);
  } catch (_) {
    ui.busy = false;
    ui.addMsg = 'Could not reach the diary API. Nothing was saved.';
    render();
  }
}

/* ---------- Events ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]');
  if (!t) {
    if (!e.target.closest('.search-wrap')) hideSearch();
    // Clicking away from the move menu puts it away, the way a menu should behave.
    if (ui.moveMenu) { ui.moveMenu = false; ui.moveCat = null; render(); }
    return;
  }
  const a = t.dataset.action, v = t.dataset.v;
  if (a === 'mode-toggle') { prefs.mode = prefs.mode === 'light' ? 'dark' : 'light'; applyPrefs(); savePrefs(); }
  else if (a === 'mode-set') { prefs.mode = v; applyPrefs(); savePrefs(); render(); }
  else if (a === 'theme-set') { prefs.theme = v; applyPrefs(); savePrefs(); render(); }
  else if (a === 'look-font') { prefs.font = v; applyPrefs(); savePrefs(); render(); }
  else if (a === 'look-accent') { prefs.accent = v; applyPrefs(); savePrefs(); render(); }
  else if (a === 'look-chips') { prefs.chips = v; savePrefs(); render(); }
  else if (a === 'key-kind') { state.keyKind = v === 'write' ? 'write' : 'read'; render(); }
  else if (a === 'look-reset') {
    prefs.font = ''; prefs.accent = ''; prefs.cats = {}; prefs.chips = 'pills';
    ui.previewTab = 'all'; applyPrefs(); savePrefs(); render();
    toast('Look reset to the theme defaults.');
  }
  // The sample on the Look page is the day's own renderer, so it answers clicks too.
  else if (a === 'preview-tab') { ui.previewTab = v; render(); }
  else if (a === 'tab') { ui.tab = v; render(); }
  else if (a === 'compose') { ui.compose = true; ui.openNote = null; ui.addMsg = ''; ui.dueOpen = false; render(); }
  else if (a === 'close-compose') { ui.compose = false; ui.addMsg = ''; ui.dueOpen = false; render(); }
  else if (a === 'open') { ui.openNote = v; ui.moveMenu = false; ui.moveCat = null; render(); }
  else if (a === 'close-note') { ui.openNote = null; ui.moveMenu = false; ui.moveCat = null; render(); }
  else if (a === 'raw') { ui.moveMenu = false; ui.moveCat = null; ui.openRaw.has(v) ? ui.openRaw.delete(v) : ui.openRaw.add(v); render(); }
  else if (a === 'move-menu') { ui.moveMenu = !ui.moveMenu; ui.moveCat = null; render(); }
  else if (a === 'move-to') { ui.moveCat = v; if (v === 'deadline' && !ui.moveDue) ui.moveDue = iso(addDays(new Date(), 7)); render(); }
  else if (a === 'move-no') { ui.moveCat = null; render(); }
  else if (a === 'move-yes') moveNote();
  else if (a === 'due-done') markDue(v);
  else if (a === 'heatmap') { state.heatmap = v; save(); render(); }
  else if (a === 'add') addEntry();
  else if (a === 'refresh' || a === 'retry') boot();
  else if (a === 'signout') signOut();
  else if (a === 'key-copy') copyKey();
  else if (a === 'key-done') { state.newKey = null; render(); }
  else if (a === 'key-revoke') revokeKey(v);
  else if (a === 'keys-retry') { state.keys = null; state.keysError = ''; ensureKeys(); }
  else if (a === 'due-toggle') { ui.dueOpen = !ui.dueOpen; renderDuePanel(); }
  else if (a === 'due-prev') { shiftDueCal(-1); renderDuePanel(); }
  else if (a === 'due-next') { shiftDueCal(1); renderDuePanel(); }
  else if (a === 'due-day') { setDuePick(v); ui.dueOpen = false; renderDuePanel(); }
  else if (a === 'due-today') { setDuePick(TODAY); ui.dueCal = TODAY.slice(0, 7); ui.dueOpen = false; renderDuePanel(); }
  else if (a === 'due-clear') { setDuePick(''); ui.dueOpen = false; renderDuePanel(); }
  else if (a === 'search-open') openSearchResult(v);
});
document.addEventListener('input', e => {
  if (e.target && e.target.id === 'search') { searchActive = -1; renderSearchPop(); return; }
  // A colour picker fires as it is dragged, so this path deliberately does not re-render:
  // rebuilding the page would close the picker mid-drag. The dot beside it and the sample
  // tabs are patched in place instead, and the next render paints everything else.
  const id = e.target && e.target.dataset ? e.target.dataset.cat : null;
  if (id) {
    prefs.cats[id] = e.target.value;
    applyPrefs(); savePrefs();
    const dot = e.target.previousElementSibling;
    if (dot) dot.style.background = e.target.value;
    const sample = $('#tabpreview');
    if (sample) sample.innerHTML = tabsHTML(LOOK_SAMPLE, ui.previewTab, { chips: prefs.chips, preview: true });
  }
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
    ui.compose = true; ui.openNote = null; ui.addMsg = ''; ui.dueOpen = false; render(); return;
  }
  if (e.key === 'Escape') {
    hideSearch();
    if (ui.compose) { ui.compose = false; ui.addMsg = ''; ui.dueOpen = false; render(); return; }
    if (ui.openNote) { ui.openNote = null; render(); }
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'set-week') { state.weekStart = e.target.value; save(); render(); }
  if (e.target.id === 'add-cat') renderDuePanel();
  // The dropdown shape is the one category filter that reports a change, not a click.
  if (e.target.id === 'tab-sel') { ui.tab = e.target.value; render(); }
  if (e.target.id === 'preview-tab-sel') { ui.previewTab = e.target.value; render(); }
});
// The passphrase form answers its own submit, so Enter works from any of its three fields.
document.addEventListener('submit', e => {
  if (e.target && e.target.id === 'pass-form') { e.preventDefault(); changePassphrase(); }
  if (e.target && e.target.id === 'key-form') { e.preventDefault(); createKey(); }
});
// A revealed key does not survive leaving the page: it belongs to the moment it was minted.
window.addEventListener('hashchange', () => { ui.tab = 'all'; ui.compose = false; ui.dueOpen = false; state.newKey = null; render(); window.scrollTo(0, 0); });

/* ---------- Unlocking, and the first read ---------- */
function showSignin(message) {
  state.signedIn = false;
  const s = $('#signin'), app = $('#app'), row = $('#crumbrow'), err = $('#signin-err');
  if (s) s.hidden = false;
  if (app) app.hidden = true;
  if (row) row.hidden = true;
  if (err) err.textContent = message || '';
  setTimeout(() => { const i = $('#signin-pass'); if (i) i.focus(); }, 0);
}
function showDiary() {
  state.signedIn = true;
  const s = $('#signin'), app = $('#app');
  if (s) s.hidden = true;
  if (app) app.hidden = false;
}
async function boot() {
  const r = await loadDiary();
  // A 401 is a lock and gets the gate. Anything else is a failed read: the diary stays on
  // screen behind the message, because asking for the passphrase again would look like the
  // passphrase was wrong.
  if (r.needLogin) { showSignin(); return; }
  showDiary();
  ui.dueCal = (ui.duePick || TODAY).slice(0, 7);
  render();
  if (r.error) {
    $('#app').innerHTML = `<section class="card"><span class="kicker">The diary</span>
      <h2 style="margin:2px 0 8px">${esc(r.error)}</h2>
      <p class="muted" style="margin:0 0 12px">Nothing is lost; the page could not read it.</p>
      <button class="btn" data-action="retry">Try again</button></section>`;
    const row = $('#crumbrow'); if (row) row.hidden = true;
  }
}
async function signOut() {
  try { await fetch('/api/session', { method: 'DELETE' }); } catch (_) {}
  state.days = {};
  // The key list and any revealed secret belong to the session that just ended.
  state.keys = null; state.keysError = ''; state.newKey = null; state.keysLoading = false;
  ui.openNote = null; ui.compose = false; ui.dueOpen = false;
  render();
  showSignin('Signed out. The diary is locked.');
}
const signinForm = $('#signin-form');
if (signinForm) signinForm.addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#signin-pass'), btn = signinForm.querySelector('button'), err = $('#signin-err');
  if (!input || !input.value) return;
  btn.disabled = true;
  if (err) err.textContent = '';
  let data = null, status = 0;
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: input.value }),
    });
    status = res.status;
    data = await res.json().catch(() => null);
  } catch (_) {
    btn.disabled = false;
    if (err) err.textContent = 'Could not reach the diary.';
    return;
  }
  btn.disabled = false;
  if (!data || !data.ok) {
    if (err) err.textContent = (data && data.error) || `Sign-in answered ${status}.`;
    input.select();
    return;
  }
  input.value = '';
  await boot();
});

applyPrefs();
if (!location.hash) history.replaceState(null, '', '#/');
boot();
