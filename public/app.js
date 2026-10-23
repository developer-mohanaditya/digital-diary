// Digital Diary: the served application (markup lives in index.html).
// Reads the journal from /api/entries, which sits behind Cloudflare Access.
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
let TODAY = '2026-10-13'; // set from the real clock once iso() exists

const $ = s => document.querySelector(s);
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
TODAY = iso(new Date());
const parse = k => { const [y,m,d] = k.split('-').map(Number); return new Date(y, m-1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate()+n); return x; };
const dim = (y, m) => new Date(y, m, 0).getDate();
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDay = d => d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
const shortDay = d => d.toLocaleDateString('en-GB', { day:'numeric', month:'short' });
const fmtDue = k => parse(k).toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
const fmtShort2y = k => { const d = parse(k); return `${pad(d.getDate())} ${MONTHS[d.getMonth()].slice(0,3)} ${String(d.getFullYear()).slice(2)}`; };
const levelOf = n => n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
/* The diary is read from the Worker's API; nothing here is invented. */
let state = { days: {} };
const saveState = () => {};
const items = k => state.days[k] || [];
const tallyInto = (c, list) => list.forEach(it => { c[it.cat] = (c[it.cat] || 0) + 1; });

async function loadDiary() {
  const from = iso(addDays(new Date(), -365));
  let res;
  try { res = await fetch(`/api/entries?from=${from}&to=${TODAY}`); }
  catch (_) { return { error: 'Could not reach the diary API.' }; }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok || !data || !data.ok) return { error: (data && data.error) || `The diary API answered ${res.status}.` };
  const days = {};
  for (const [k, list] of Object.entries(data.days || {})) {
    days[k] = list.map(it => ({ sec: 0, pic: false, ...it, k }));
  }
  state.days = days;
  return { timeZone: data.timeZone };
}

/* Preferences: theme (Minimal default, Paper, Dark Journal) and light/dark mode. */
const SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const THEMES = ['minimal', 'paper', 'journal'];
const prefs = { theme:'minimal', mode:'light' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('diary-prefs-v2') || '{}')); } catch (_) {}
if (!THEMES.includes(prefs.theme)) prefs.theme = 'minimal';
if (!['light', 'dark'].includes(prefs.mode)) prefs.mode = 'light';
function applyPrefs() {
  document.body.dataset.theme = prefs.theme;
  document.body.dataset.mode = prefs.mode;
  const mb = $('#mode-btn');
  mb.innerHTML = prefs.mode === 'light' ? MOON_ICON : SUN_ICON;
  mb.setAttribute('aria-label', prefs.mode === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
}
function savePrefs() { try { localStorage.setItem('diary-prefs-v2', JSON.stringify(prefs)); } catch (_) {} }
/* Setup page (setup.html) is the source of truth when present: theme, font, accent, category colors, chip variant. */
let chipVariant = 'pills';
try {
  const sc = JSON.parse(localStorage.getItem('diary-setup-v1'));
  if (sc) {
    if (sc.theme) prefs.theme = sc.theme;
    if (sc.mode) prefs.mode = sc.mode;
    if (sc.font) document.body.dataset.font = sc.font;
    if (sc.accent) document.body.style.setProperty('--accent', sc.accent);
    if (sc.cats) CATS.forEach(c => { if (sc.cats[c.id]) c.color = sc.cats[c.id]; });
    if (sc.chips) chipVariant = sc.chips;
  }
} catch (_) {}

const ui = { range:'month', anchor:TODAY, tab:'all', layout:'ledger', openNote:null, moveMenu:false, moveConfirm:null, openRaw:new Set(), openMove:new Set(), openFull:new Set(), duePick:'', dueCal:TODAY.slice(0,7), dueOpen:false };
let pendingNote = null;

/* ---------- Live search (tolerant, no Enter needed) ---------- */
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function tokenScore(qt, words, hay) {
  if (hay.includes(qt)) return qt.length >= 4 ? 3 : 2;                    // exact substring
  for (const w of words) {
    if (w.startsWith(qt)) return 2;                                       // prefix of a word
    if (qt.length >= 4 && w.length >= 4 && lev(qt, w) <= 1) return 1;     // one typo off
  }
  return 0;
}
function scoreNote(qtoks, it, k) {
  const hay = norm(`${it.text} ${CAT[it.cat] ? CAT[it.cat].label : ''} ${MODE_LABEL[it.mode] || ''} ${k} ${fmtDay(parse(k))}`);
  const words = hay.split(' ');
  let s = 0;
  for (const qt of qtoks) {
    const v = tokenScore(qt, words, hay);
    if (!v) return -1;                                                    // every token must match somewhere
    s += v + (norm(it.text).startsWith(qt) ? 1 : 0);
  }
  if (norm(it.text).includes(qtoks.join(' '))) s += 3;                    // whole-phrase bonus
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
  for (const qt of qtoks.sort((a, b) => b.length - a.length)) {
    if (qt.length < 2) continue;
    try { h = h.replace(new RegExp(`(${qt.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>'); }
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
  const i = ref.indexOf('|'), k = ref.slice(0, i);
  const d = parse(k);
  const target = `#/y/${d.getFullYear()}/m/${d.getMonth()+1}/d/${d.getDate()}`;
  hideSearch();
  const inp = $('#search'); if (inp) inp.value = '';
  if (location.hash === target) { ui.openNote = ref; ui.moveMenu = false; ui.moveConfirm = null; render(); }
  else { pendingNote = ref; location.hash = target; }
  window.scrollTo(0, 0);
}

function route() {
  const p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (p[0] === 'y' && p[1] && p[2] === 'm' && p[3]) {
    const y = +p[1], m = +p[3];
    if (p[4] === 'd' && p[5]) return { view:'day', y, m, d:+p[5] };
    return { view:'month', y, m };
  }
  return { view:'home' };
}

function bounds() {
  const a = parse(ui.anchor);
  if (ui.range === 'day') return { from:a, to:a };
  if (ui.range === 'week') { const from = addDays(a, -((a.getDay() + 6) % 7)); return { from, to:addDays(from, 6) }; }
  if (ui.range === 'month') return { from:new Date(a.getFullYear(), a.getMonth(), 1), to:new Date(a.getFullYear(), a.getMonth()+1, 0) };
  return { from:new Date(a.getFullYear(), 0, 1), to:new Date(a.getFullYear(), 11, 31) };
}
function rangeLabel() {
  const { from, to } = bounds();
  if (ui.range === 'day') return fmtDay(from);
  if (ui.range === 'year') return String(from.getFullYear());
  if (ui.range === 'month') return `${MONTHS[from.getMonth()]} ${from.getFullYear()}`;
  return `${shortDay(from)} to ${shortDay(to)} ${to.getFullYear()}`;
}
function rangeItems() {
  const { from, to } = bounds(); const out = [];
  for (let d = new Date(from); d <= to; d = addDays(d, 1)) out.push(...items(iso(d)));
  return out;
}
function buckets() {
  const { from, to } = bounds();
  if (ui.range === 'day') {
    const b = Array.from({ length:24 }, (_, h) => ({ label:pad(h), counts:{} }));
    items(iso(from)).forEach(it => tallyInto(b[+it.time.slice(0,2)].counts, [it]));
    return b;
  }
  if (ui.range === 'year') {
    const y = from.getFullYear(), b = [];
    for (let m = 1; m <= 12; m++) {
      const c = {};
      for (let d = 1; d <= dim(y, m); d++) tallyInto(c, items(`${y}-${pad(m)}-${pad(d)}`));
      b.push({ label:MONTHS[m-1].slice(0,3), counts:c });
    }
    return b;
  }
  const b = [];
  for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
    const c = {}; tallyInto(c, items(iso(d)));
    b.push({ label: ui.range === 'week' ? d.toLocaleDateString('en-GB', { weekday:'short' }) : String(d.getDate()), counts:c });
  }
  return b;
}

/* ---------- Charts (plain SVG) ---------- */
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
      // 2px gap between stacked segments keeps each block distinct
      s += `<rect x="${x}" y="${base + 1}" width="${bw}" height="${Math.max(1, full - 2)}" rx="3" fill="${c.color}"><title>${esc(b.label)} · ${c.label}: ${n}</title></rect>`;
    });
    if (i % every === 0) s += `<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  return s + '</svg>';
}
// Category composition: one slim proportional bar plus text keys (no boxes).
function compHTML(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return '<p class="muted">No items in this range.</p>';
  const act = CATS.filter(c => counts[c.id]);
  const bar = act.map(c => `<span style="flex:${counts[c.id]};background:${c.color}" title="${c.label}: ${counts[c.id]}"></span>`).join('');
  const keys = act.map(c => `<span class="k"><i style="background:${c.color}"></i>${c.label}<em>${counts[c.id]} · ${Math.round(counts[c.id] / total * 100)}%</em></span>`).join('');
  return `<div class="comp"><div class="bar">${bar}</div><div class="keys">${keys}</div></div>`;
}
function hourHistogram() {
  const all = Object.entries(state.days).flatMap(([k, list]) => list.map(it => ({ ...it, k })));
  const c = Array(24).fill(0); all.forEach(it => c[+it.time.slice(0,2)]++);
  const total = all.length || 1, max = Math.max(1, ...c);
  const isOut = n => n > 0 && n / total < 0.03;
  const W = 720, H = 200, P = 24, bw = (W - P * 2) / 24;
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Items by hour of day">`;
  c.forEach((n, h) => {
    const hh = (H - P * 2) * n / max, x = P + h * bw + 3, y = H - P - hh;
    s += `<rect class="${isOut(n) ? 'out' : 'bar'}" x="${x}" y="${y}" width="${bw-6}" height="${hh}" rx="3"><title>${pad(h)}:00 · ${n} items${isOut(n) ? ' (outlier)' : ''}</title></rect>`;
    if (h % 3 === 0) s += `<text class="axis" x="${x + (bw-6)/2}" y="${H-6}" text-anchor="middle">${pad(h)}</text>`;
  });
  s += '</svg>';
  const outliers = all.filter(it => isOut(c[+it.time.slice(0,2)])).sort((a, b) => b.k.localeCompare(a.k) || b.time.localeCompare(a.time)).slice(0, 6);
  const list = outliers.length
    ? `<ul class="outlier-list">${outliers.map(it => `<li><span class="tag">Outlier ${it.time}</span> · <a href="#/y/${it.k.slice(0,4)}/m/${+it.k.slice(5,7)}/d/${+it.k.slice(8,10)}">${it.k}</a> · ${CAT[it.cat].label}<br><span class="muted">${esc(it.text)}</span></li>`).join('')}</ul>`
    : '<p class="muted">No outliers yet.</p>';
  return s + list;
}
function yearHeat(y) {
  let h = '<div class="heat">';
  for (let m = 1; m <= 12; m++) {
    h += `<div class="hrow"><span class="hm">${MONTHS[m-1].slice(0,3)}</span>`;
    for (let d = 1; d <= 31; d++) {
      if (d > dim(y, m)) { h += '<span class="hc blank"></span>'; continue; }
      const k = `${y}-${pad(m)}-${pad(d)}`, n = items(k).length, future = k > TODAY;
      h += `<a class="hc l${levelOf(n)}${future ? ' na' : ''}" href="#/y/${y}/m/${m}/d/${d}" title="${k}: ${n} items"></a>`;
    }
    h += '</div>';
  }
  return h + '</div>';
}
function monthCalendar(y, m) {
  const lead = (new Date(y, m-1, 1).getDay() + 6) % 7;
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<span class="cell blank"></span>';
  for (let d = 1; d <= dim(y, m); d++) {
    const k = `${y}-${pad(m)}-${pad(d)}`, n = items(k).length;
    cells += `<a class="cell l${levelOf(n)}" href="#/y/${y}/m/${m}/d/${d}"><b>${d}</b><small>${n ? n + ' items' : ''}</small></a>`;
  }
  return `<div class="cal">${['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(x => `<span class="dow">${x}</span>`).join('')}${cells}</div>`;
}
function donut(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return '<p class="muted">No items yet.</p>';
  const C = 2 * Math.PI * 40; let cum = 0, arcs = '';
  CATS.forEach(c => {
    const n = counts[c.id] || 0; if (!n) return;
    const f = n / total;
    arcs += `<circle r="40" cx="60" cy="60" fill="none" stroke="${c.color}" stroke-width="16" stroke-dasharray="${f*C} ${C}" stroke-dashoffset="${-cum*C}" transform="rotate(-90 60 60)"><title>${c.label}: ${n}</title></circle>`;
    cum += f;
  });
  return `<div class="donut"><svg viewBox="0 0 120 120">${arcs}<text class="dtot" x="60" y="66" text-anchor="middle">${total}</text></svg>${compHTML(counts)}</div>`;
}
function monthSummary(y, m) {
  const its = [];
  for (let d = 1; d <= dim(y, m); d++) { const k = `${y}-${pad(m)}-${pad(d)}`; items(k).forEach(it => its.push({ ...it, k })); }
  if (!its.length) return '<p class="muted">No entries this month yet.</p>';
  const counts = {}; tallyInto(counts, its);
  const perDay = {}; its.forEach(it => perDay[it.k] = (perDay[it.k] || 0) + 1);
  const busiest = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0];
  const hours = Array(24).fill(0); its.forEach(it => hours[+it.time.slice(0,2)]++);
  const peak = hours.indexOf(Math.max(...hours));
  const night = its.filter(it => +it.time.slice(0,2) < 5).length;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return `<div class="summary">
    <p>In ${MONTHS[m-1]}, you logged <b>${its.length}</b> items across <b>${Object.keys(perDay).length}</b> days. ${CAT[top[0]].label} led with <b>${top[1]}</b>.</p>
    <p>Your busiest day was <b>${busiest[0].slice(8)} ${MONTHS[m-1].slice(0,3)}</b> with ${busiest[1]} items. Peak writing hour: <b>${pad(peak)}:00</b>.</p>
    <p>${night ? `${night} entries were written between midnight and 5am.` : 'No late-night entries this month.'}</p>
    <p class="muted" style="font-size:.8rem">Computed from your entries. The AI summary (highlights, failures, resilience) arrives with the LLM step.</p>
  </div>`;
}

function viewHome() {
  const y = parse(ui.anchor).getFullYear();
  const openDl = Object.values(state.days).flat().filter(it => it.cat === 'deadline' && !it.done).length;
  const rItems = rangeItems();
  const counts = {}; tallyInto(counts, rItems);
  const activeDays = new Set(rItems.map(it => it.id.slice(0,10))).size;
  const seg = ['day','week','month','year'].map(r => `<button data-action="range" data-v="${r}" aria-pressed="${ui.range===r}">${r[0].toUpperCase()+r.slice(1)}</button>`).join('');
  const months = MONTHS.map((name, i) => {
    const m = i + 1;
    const n = Object.keys(state.days).filter(k => k.startsWith(`${y}-${pad(m)}`)).reduce((a, k) => a + items(k).length, 0);
    const future = `${y}-${pad(m)}-01` > TODAY;
    return `<a class="folder${future ? ' off' : ''}" href="#/y/${y}/m/${m}"><strong>${name}</strong><span>${n} items</span></a>`;
  }).join('');
  return `
  <section class="hero"><span class="kicker">Your diary</span><h1>Explore ${y}, one day at a time.</h1></section>
  <section class="kpis" style="margin-top:16px">
    <div class="kpi"><b>${rItems.length}</b><span>items</span></div>
    <div class="kpi"><b>${counts.thought||0}</b><span>thoughts</span></div>
    <div class="kpi"><b>${counts.learning||0}</b><span>learnings</span></div>
    <div class="kpi"><b>${counts.class||0}</b><span>class notes</span></div>
    <div class="kpi"><b>${openDl}</b><span>open deadlines</span></div>
    <div class="kpi"><b>${activeDays}</b><span>active days</span></div>
  </section>
  <section class="card">
    <div class="navrow act-head">
      <div class="act-title"><span class="kicker">Activity</span><h2 style="margin:2px 0 0">${rangeLabel()}</h2></div>
      <div class="act-datenav">
        <button class="btn" data-action="shift" data-v="-1" aria-label="Previous">‹</button>
        <button class="btn" data-action="shift" data-v="0">Today</button>
        <button class="btn" data-action="shift" data-v="1" aria-label="Next">›</button>
      </div>
      <div class="seg act-seg">${seg}</div>
    </div>
    ${stackChart(buckets(), 'Activity by category')}
    ${compHTML(counts)}
  </section>
  <section class="card"><span class="kicker">Calendar</span><h2>${y} at a glance</h2>${yearHeat(y)}</section>
  <section class="card"><span class="kicker">When you write</span><h2>Hour of day · all time</h2>${hourHistogram()}</section>
  <section class="card"><span class="kicker">Folders</span><h2>${y}</h2><div class="folders">${months}</div></section>`;
}

function monthLedger(y, m) {
  const its = [];
  for (let d = 1; d <= dim(y, m); d++) { const k = `${y}-${pad(m)}-${pad(d)}`; items(k).forEach(it => its.push({ ...it, k })); }
  if (!its.length) return '<p class="muted">Nothing here yet.</p>';
  return CATS.filter(c => its.some(it => it.cat === c.id)).map(c => {
    const rows = its.filter(it => it.cat === c.id).sort((a, b) => a.k === b.k ? a.time.localeCompare(b.time) : (a.k < b.k ? -1 : 1));
    return `<div class="lgrp"><i class="gdot" style="background:${c.color}"></i>${c.label} <span class="n">(${rows.length})</span></div><div class="ledg">${rows.map(it => ledgerRowHTML(it, it.k, true)).join('')}</div>`;
  }).join('');
}

function viewMonth(y, m) {
  const k = `${y}-${pad(m)}`;
  const days = []; for (let d = 1; d <= dim(y, m); d++) days.push(d);
  const counts = {}; days.forEach(d => tallyInto(counts, items(`${k}-${pad(d)}`)));
  const folders = days.map(d => {
    const kk = `${k}-${pad(d)}`, list = items(kk), future = kk > TODAY;
    let dot = '';
    if (list.length) {
      const c = {}; tallyInto(c, list);
      const dominant = Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
      dot = `<i class="dot" style="background:${CAT[dominant].color}"></i>`;
    }
    return `<a class="folder${future ? ' off' : ''}" href="#/y/${y}/m/${m}/d/${d}"><strong>${d} ${MONTHS[m-1].slice(0,3)}</strong><span>${dot}${list.length} items</span></a>`;
  }).join('');
  return `
  <section class="hero"><span class="kicker">${y}</span><h1>${MONTHS[m-1]}</h1></section>
  <section class="grid2" style="margin-top:16px">
    <div class="card"><span class="kicker">Calendar</span><h2>Pick a day</h2>${monthCalendar(y, m)}</div>
    <div class="card"><span class="kicker">Mix</span><h2>Categories this month</h2>${donut(counts)}</div>
  </section>
  <section class="card"><span class="kicker">Summary</span><h2>${MONTHS[m-1]} in review</h2>${monthSummary(y, m)}</section>
  <section class="card"><span class="kicker">Ledger</span><h2>Everything this month, by category</h2>${monthLedger(y, m)}</section>
  <section class="card"><span class="kicker">Days</span><h2>Folders</h2><div class="folders">${folders}</div></section>`;
}

/* Deadlines carry their own schema: a due date plus done flag, rendered as status pills. */
function dueDays(due) { return Math.round((parse(due) - parse(TODAY)) / 864e5); }
function duePill(it) {
  if (it.cat !== 'deadline') return '';
  if (it.done) return '<span class="due done">Done</span>';
  if (!it.due) return '';
  const n = dueDays(it.due);
  if (n < 0) return `<span class="due over">Overdue ${-n}d</span>`;
  if (n === 0) return '<span class="due soon">Due today</span>';
  if (n === 1) return '<span class="due soon">Due tomorrow</span>';
  return `<span class="due soon">Due in ${n}d</span>`;
}
function dueLine(it) {
  if (it.cat !== 'deadline') return '';
  const when = it.due ? fmtDay(parse(it.due)) : 'No due date';
  const n = it.due ? dueDays(it.due) : null;
  const st = it.done ? 'Done' : n === null ? '' : n < 0 ? `${-n} days overdue` : n === 0 ? 'due today' : `${n} days left`;
  return `<div class="duline">${duePill(it)}<span class="muted">${esc(when)}${st ? ` · ${st}` : ''}</span></div>`;
}
function entryHTML(it, k) {
  const c = CAT[it.cat];
  const rawOpen = ui.openRaw.has(it.id), moveOpen = ui.openMove.has(it.id);
  const opts = CATS.map(x => `<option value="${x.id}"${x.id === it.cat ? ' selected' : ''}>${x.label}</option>`).join('');
  return `
    <article class="entry" style="--c:${c.color}">
      <div class="meta">
        <span class="time">${it.time}</span><span class="chip">${c.label}</span><span class="mode">${MODE_LABEL[it.mode]}</span>${duePill(it)}
        <button class="rawtag" data-action="raw" data-v="${it.id}" aria-pressed="${rawOpen}">Raw</button>
      </div>
      <p>${esc(it.text)}</p>
      ${rawOpen ? `<div class="raw"><span class="kicker">Raw</span><p>${esc(it.raw || it.text)}</p></div>` : ''}
      <div class="actions">
        ${moveOpen
          ? `<label>Move to <select data-move="${k}|${it.id}">${opts}</select></label>`
          : `<button class="link" data-action="move" data-v="${it.id}">Move to</button>`}
        <span>Source · ${it.src}</span>
      </div>
    </article>`;
}

function ledgerRowHTML(it, k, withDay = false) {
  return `<div class="lrow clickable" data-action="open" data-v="${k}|${it.id}" tabindex="0" role="button" title="Open note">
      <span class="ltime${withDay ? ' wide' : ''}">${withDay ? `${+it.k.slice(8)} ${it.time}` : it.time}</span>
      <span class="ltxt clamp">${esc(it.text)}</span>${duePill(it)}
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
  if (it) { it.cat = cat; it.src = 'manual'; if (cat === 'deadline' && !it.due) { it.due = iso(addDays(parse(k), 7)); it.done = false; } saveState(); }
}
function splitTitle(t) {
  const s = String(t || '');
  const nl = s.indexOf('\n');
  if (nl > 0) {
    const head = s.slice(0, nl).trim();
    const rest = s.slice(nl + 1).trim();
    if (head && head.length <= 120 && rest) return { title: head, body: rest };
  }
  const m = s.match(/^([^:\n\.?!]{3,48}):\s+(.{20,})$/s);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  return { title: '', body: s };
}
function noteTitleBody(t) {
  const { title, body } = splitTitle(t);
  return (title ? `<h3 class="stitle">${esc(title)}</h3>` : '') + `<p class="sfull">${esc(body)}</p>`;
}
function noteHTML(ref) {
  const found = findNote(ref);
  if (!found) return '';
  const { k, it } = found;
  const c = CAT[it.cat];
  const hasRaw = it.raw && it.raw !== it.text;
  const rawOpen = ui.openRaw.has(it.id);
  const opts = CATS.map(x => `<option value="${x.id}"${x.id === it.cat ? ' selected' : ''}>${x.label}</option>`).join('');
  const moveOpen = ui.moveMenu;
  return `<div class="overlay"><div class="backdrop" data-action="close-note"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Note">
      <div class="shead"><span class="sdot" style="background:${c.color}"></span><strong>${c.label}</strong><span class="mode">${MODE_LABEL[it.mode]}</span><span class="spacer"></span>${hasRaw ? `<button class="hbtn" data-action="raw" data-v="${it.id}" aria-pressed="${rawOpen}" title="${rawOpen ? 'Hide raw' : 'Show raw'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/></svg></button>` : ''}<button class="hbtn" data-action="move-menu" aria-expanded="${moveOpen}" title="Move to another category"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14l3 3 3-3"/></svg></button><button class="xbtn" data-action="close-note" aria-label="Close">\u00d7</button></div>
      ${moveOpen ? `<div class="mmenu" role="menu">${ui.moveConfirm ? `<div class="mconf"><span>Move to <b>${CAT[ui.moveConfirm].label}</b>?</span><span class="row"><button class="btn" data-action="move-yes">Yes</button><button class="btn" data-action="move-no">No</button></span></div>` : CATS.map(x => `<button data-action="move-to" data-v="${x.id}" aria-checked="${x.id === it.cat}"><i style="background:${x.color}"></i>${x.label}</button>`).join('')}</div>` : ''}
      <div class="smeta">${fmtDay(parse(k))}<i>·</i>${it.time}:${pad(it.sec || 0)}<i>·</i>${it.src === 'tag' ? 'Tagged by you' : 'Auto filed'}</div>
      ${dueLine(it)}
      ${noteTitleBody(it.text)}
      ${it.photo ? `<figure class="sfigure"><img src="${it.photo.src}" alt="Attached photo" loading="lazy" /></figure>` : ''}
      ${rawOpen && hasRaw ? `<div class="sraw"><span class="kicker">Raw</span><p>${esc(it.raw)}</p></div>` : ''}
    </div></div>`;
}
function dayTabsHTML(tabDefs) {
  const col = id => id === 'all' ? 'var(--accent)' : CAT[id].color;
  const btn = (t, cls = '', extra = '') => `<button${cls ? ` class="${cls}"` : ''} role="tab" data-action="tab" data-v="${t.id}" aria-selected="${ui.tab===t.id}"${extra}>`;
  if (chipVariant === 'underline' || chipVariant === 'colorline') {
    const colorful = chipVariant === 'colorline' ? ' colorful' : '';
    return `<div class="utabs${colorful}" role="tablist">` + tabDefs.map(t =>
      `${btn(t, '', colorful ? ` style="--c:${col(t.id)}"` : '')}${t.label}<sup>${t.n}</sup></button>`).join('') + '</div>';
  }
  if (chipVariant === 'dotchips') {
    return `<div class="ctabs" role="tablist">` + tabDefs.map(t =>
      `${btn(t, '', ` style="--c:${col(t.id)}"`)}<i style="background:${col(t.id)}"></i>${t.label}<em>${t.n}</em></button>`).join('') + '</div>';
  }
  if (chipVariant === 'segmented') {
    return `<div class="segbar" role="tablist">` + tabDefs.map(t => `${btn(t)}${t.label}<small> ${t.n}</small></button>`).join('') + '</div>';
  }
  if (chipVariant === 'dropdown') {
    return `<div class="dday" style="margin:0 0 0 auto"><select id="daycat-sel" aria-label="Filter by category">` +
      tabDefs.map(t => `<option value="${t.id}"${ui.tab===t.id ? ' selected' : ''}>${t.label} · ${t.n}</option>`).join('') + '</select></div>';
  }
  return `<div class="tabs tabs-inline" role="tablist">` + tabDefs.map(t =>
    `${btn(t, 'tab')}${t.label}<small>${t.n}</small></button>`).join('') + '</div>';
}
function ledgerHTML(list, k) {
  if (!list.length) return '<p class="muted">Nothing here yet.</p>';
  if (ui.tab !== 'all') return `<div class="ledg">${list.map(it => ledgerRowHTML(it, k)).join('')}</div>`;
  return CATS.filter(c => list.some(it => it.cat === c.id)).map(c => {
    const rows = list.filter(it => it.cat === c.id);
    return `<div class="lgrp"><i class="gdot" style="background:${c.color}"></i>${c.label} <span class="n">(${rows.length})</span></div><div class="ledg">${rows.map(it => ledgerRowHTML(it, k)).join('')}</div>`;
  }).join('');
}

function viewDay(y, m, d) {
  const k = `${y}-${pad(m)}-${pad(d)}`, date = parse(k), list = items(k);
  const dow = date.toLocaleDateString('en-GB', { weekday:'long' });
  const narrow = (typeof matchMedia === 'function') && matchMedia('(max-width:600px)').matches;
  const mon = narrow ? MONTHS[date.getMonth()].slice(0, 3) : MONTHS[date.getMonth()];
  const dmy = `${date.getDate()} ${mon} ${String(date.getFullYear()).slice(2)}`;
  const counts = {}; tallyInto(counts, list);
  if (ui.tab !== 'all' && !(counts[ui.tab] > 0)) ui.tab = 'all';
  const shown = ui.tab === 'all' ? list : list.filter(it => it.cat === ui.tab);
  const tabDefs = [{ id:'all', label:'All', n:list.length }, ...CATS.filter(c => counts[c.id] > 0).map(c => ({ id:c.id, label:c.label, n:counts[c.id] }))];
  const tabs = dayTabsHTML(tabDefs);
  const strip = Array.from({ length:24 }, (_, h) => {
    const n = list.filter(it => +it.time.slice(0,2) === h).length;
    return `<div class="${n ? 'has' : ''}" style="height:${n ? Math.min(100, 18 + n * 22) : 4}%" title="${pad(h)}:00 · ${n}"></div>`;
  }).join('');
  const entries = shown.length ? ledgerHTML(shown, k) : '<p class="muted">Nothing here yet.</p>';
  const dayLink = dt => `#/y/${dt.getFullYear()}/m/${dt.getMonth()+1}/d/${dt.getDate()}`;
  return `
  <section class="hero dayhead">
    <div class="daynav">
      <a class="btn" href="${dayLink(addDays(date, -1))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg><span class="bl-full">Previous day</span><span class="bl-short">Previous</span></a>
      <h1 class="daytitle"><span class="dow">${dow}</span><span class="dmy">${dmy}</span></h1>
      <a class="btn" href="${dayLink(addDays(date, 1))}"><span class="bl-full">Next day</span><span class="bl-short">Next</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></a>
    </div>
  </section>
  <section class="card"><div class="lhead"><span class="kicker">Categories</span>${tabs}</div>${entries}</section>
  <section class="grid2">
    <div class="card"><span class="kicker">Timeline</span><h2>Hours</h2><div class="strip">${strip}</div><div class="ticks">${Array.from({length:24},(_,h)=>`<span>${h%3===0?pad(h):''}</span>`).join('')}</div></div>
    <div class="card"><span class="kicker">New note</span><h2>Add an item</h2>
      <form class="add" onsubmit="return false">
        <textarea id="add-text" placeholder="Type a thought, quote or note…"></textarea>
        <div class="row">
          <select id="add-mode"><option value="refined">Refined</option><option value="verbatim">Verbatim (/push)</option><option value="reason">Reason (/reason)</option><option value="think">Think (/think)</option></select>
          <select id="add-cat"><option value="">Auto (Inbox for now)</option>${CATS.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}</select>
          <span class="duewrap" hidden>
            <button class="btn duebtn" type="button" data-action="due-toggle" aria-haspopup="dialog" aria-expanded="false" title="Pick a due date"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg><span id="due-label">${ui.duePick ? esc(fmtDue(ui.duePick)) : 'Due date'}</span></button>
            <input type="hidden" id="add-due" value="${ui.duePick || ''}" />
            <div class="duepop" id="due-pop" role="dialog" aria-label="Pick a due date" hidden></div>
          </span>
          <button class="btn" type="button" data-action="add">Add</button>
        </div>
      </form>
    </div>
  </section>`;
}

function renderCrumbs(r) {
  let html = '<a href="#/">Home</a>';
  if (r.view !== 'home') html += `<span class="sep">/</span><a href="#/y/${r.y}/m/${r.m}">${MONTHS[r.m-1]} ${r.y}</a>`;
  if (r.view === 'day') html += `<span class="sep">/</span><span>${r.d}</span><span class="c-count">${items(`${r.y}-${pad(r.m)}-${pad(r.d)}`).length} items</span>`;
  $('#crumbs').innerHTML = html;
}
function render() {
  const r = route();
  renderCrumbs(r);
  if (r.view === 'day') ui.anchor = `${r.y}-${pad(r.m)}-${pad(r.d)}`;
  $('#app').innerHTML = r.view === 'home' ? viewHome() : r.view === 'month' ? viewMonth(r.y, r.m) : viewDay(r.y, r.m, r.d);
  document.querySelector('.overlay')?.remove();
  if (ui.openNote) { const h = noteHTML(ui.openNote); if (h) document.body.insertAdjacentHTML('beforeend', h); else ui.openNote = null; }
}
function shiftAnchor(n) {
  const a = parse(ui.anchor);
  if (ui.range === 'day') ui.anchor = iso(addDays(a, n));
  else if (ui.range === 'week') ui.anchor = iso(addDays(a, 7 * n));
  else if (ui.range === 'month') ui.anchor = iso(new Date(a.getFullYear(), a.getMonth() + n, 1));
  else ui.anchor = `${a.getFullYear() + n}-01-01`;
  if (ui.anchor > TODAY) ui.anchor = TODAY;
}
/* Custom due-date picker in the site's own design language (replaces the native date popup). */
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
function renderDuePop() {
  const pop = $('#due-pop'); if (!pop) return;
  pop.innerHTML = dueCalHTML();
  pop.hidden = !ui.dueOpen;
  document.querySelector('.duebtn')?.setAttribute('aria-expanded', String(ui.dueOpen));
}
function setDuePick(v) {
  ui.duePick = v || '';
  const inp = $('#add-due'); if (inp) inp.value = ui.duePick;
  const lab = $('#due-label'); if (lab) lab.textContent = ui.duePick ? fmtDue(ui.duePick) : 'Due date';
}
function shiftDueCal(n) {
  const [yy, mm] = ui.dueCal.split('-').map(Number);
  const d = new Date(yy, mm - 1 + n, 1);
  ui.dueCal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
function addEntry() {
  const text = $('#add-text').value.trim();
  if (!text) return;
  const now = new Date();
  const k = route().view === 'day' ? ui.anchor : TODAY;
  const chosen = $('#add-cat').value;
  const it = {
    id: `${k}-${Date.now()}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    cat: chosen || 'inbox',
    mode: $('#add-mode').value,
    src: chosen ? 'manual' : 'auto',
    text,
    raw: text,
  };
  if (it.cat === 'deadline') { it.due = $('#add-due').value || iso(addDays(new Date(), 7)); it.done = false; }
  state.days[k] = [...items(k), it].sort((a, b) => a.time.localeCompare(b.time));
  ui.duePick = '';
  saveState(); render();
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]'); if (!t) return;
  const a = t.dataset.action, v = t.dataset.v;
  if (a === 'mode-toggle') { prefs.mode = prefs.mode === 'light' ? 'dark' : 'light'; applyPrefs(); savePrefs(); }
  else if (a === 'range') { ui.range = v; render(); }
  else if (a === 'shift') { if (v === '0') ui.anchor = TODAY; else shiftAnchor(+v); render(); }
  else if (a === 'tab') { ui.tab = v; render(); }
  else if (a === 'raw') { if (ui.moveMenu) { ui.moveMenu = false; ui.moveConfirm = null; } ui.openRaw.has(v) ? ui.openRaw.delete(v) : ui.openRaw.add(v); render(); }
  else if (a === 'move') { ui.openMove.add(v); render(); }
  else if (a === 'more') { ui.openFull.has(v) ? ui.openFull.delete(v) : ui.openFull.add(v); render(); }
  else if (a === 'open') { ui.openNote = v; ui.moveMenu = false; ui.moveConfirm = null; render(); }
  else if (a === 'close-note') { ui.openNote = null; ui.moveMenu = false; ui.moveConfirm = null; render(); }
  else if (a === 'move-menu') { ui.moveMenu = !ui.moveMenu; ui.moveConfirm = null; render(); }
  else if (a === 'move-to') { ui.moveConfirm = v; render(); }
  else if (a === 'move-no') { ui.moveConfirm = null; render(); }
  else if (a === 'move-yes') { const f = ui.openNote && findNote(ui.openNote); if (f && ui.moveConfirm) doMove(f.k, f.it.id, ui.moveConfirm); ui.moveConfirm = null; ui.moveMenu = false; render(); }
  else if (a === 'due-toggle') { ui.dueOpen = !ui.dueOpen; if (ui.dueOpen && !ui.dueCal) ui.dueCal = (ui.duePick || TODAY).slice(0, 7); renderDuePop(); }
  else if (a === 'due-prev') { shiftDueCal(-1); renderDuePop(); }
  else if (a === 'due-next') { shiftDueCal(1); renderDuePop(); }
  else if (a === 'due-day') { setDuePick(v); ui.dueOpen = false; renderDuePop(); }
  else if (a === 'due-today') { setDuePick(TODAY); ui.dueCal = TODAY.slice(0, 7); ui.dueOpen = false; renderDuePop(); }
  else if (a === 'due-clear') { setDuePick(''); ui.dueOpen = false; renderDuePop(); }
  else if (a === 'add') addEntry();
  else if (a === 'search-open') openSearchResult(v);
});
document.addEventListener('input', e => { if (e.target && e.target.id === 'search') { searchActive = -1; renderSearchPop(); } });
document.addEventListener('keydown', e => {
  const inp = e.target && e.target.id === 'search' ? e.target : null;
  if (!inp) return;
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
});
document.addEventListener('change', e => {
  if (e.target.id === 'daycat-sel') { ui.tab = e.target.value; render(); return; }
  if (e.target.id === 'add-cat') { const w = document.querySelector('.duewrap'); if (w) w.hidden = e.target.value !== 'deadline'; }
  const s = e.target.closest('[data-move]'); if (!s) return;
  const [k, id] = s.dataset.move.split('|');
  const it = items(k).find(x => x.id === id);
  if (it) { it.cat = s.value; it.src = 'manual'; ui.openMove.delete(id); saveState(); render(); }
});
document.addEventListener('click', e => { if (ui.dueOpen && e.target.isConnected && !e.target.closest('.duewrap')) { ui.dueOpen = false; renderDuePop(); } if (!e.target.closest('.search-wrap')) hideSearch(); });
/* Move menu is transient: any click outside it (or on RAW) collapses it. RAW itself stays put. */
document.addEventListener('click', e => {
  if (!ui.moveMenu || !ui.openNote) return;
  if (e.target.closest('.mmenu, [data-action="move-menu"], [data-action="move-to"], [data-action="move-yes"], [data-action="move-no"]')) return;
  ui.moveMenu = false; ui.moveConfirm = null; render();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (ui.dueOpen) { ui.dueOpen = false; renderDuePop(); } if (ui.openNote) { ui.openNote = null; render(); } return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element) {
    const t = e.target.closest('[data-action="open"]');
    if (t) { e.preventDefault(); ui.openNote = t.dataset.v; render(); }
  }
});
window.addEventListener('hashchange', () => { ui.tab = 'all'; ui.openNote = pendingNote; pendingNote = null; render(); window.scrollTo(0, 0); });

applyPrefs();
if (!location.hash) history.replaceState(null, '', '#/');
render();
loadDiary().then(r => {
  render();
  if (r.error) $('#app').insertAdjacentHTML('afterbegin', `<div class="muted" style="padding:16px 0">${esc(r.error)}</div>`);
});
