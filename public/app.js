// Digital Diary: the served application.
// Reads the journal from /api/entries (behind Cloudflare Access) and renders it.
const CATS = [
  { id:'class',    label:'Class',    color:'#4f6ef7' },
  { id:'learning', label:'Learning', color:'#14a37f' },
  { id:'thought',  label:'Thought',  color:'#e8a33d' },
  { id:'quote',    label:'Quote',    color:'#c2578a' },
  { id:'work',     label:'Work',     color:'#64748b' },
  { id:'project',  label:'Project',  color:'#8b5cf6' },
  { id:'life',     label:'Life',     color:'#f0643c' },
  { id:'task',     label:'Task',     color:'#0ea5b7' },
  { id:'deadline', label:'Deadline', color:'#e05a4f' },
  { id:'inbox',    label:'Inbox',    color:'#9ca3af' },
];
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const MODE_LABEL = { refined:'Refined', verbatim:'Verbatim', reason:'Reason', think:'Think' };
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
let TODAY = '2026-10-13'; // set properly just below, once iso() exists

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
const levelOf = n => n === 0 ? 0 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
/* The diary comes from the Worker's read API; nothing is invented in the browser. */
let state = { days: {} };
const saveState = () => {};
const items = k => state.days[k] || [];

async function loadDiary() {
  const from = iso(addDays(new Date(), -180));
  let res;
  try { res = await fetch(`/api/entries?from=${from}&to=${TODAY}`); }
  catch (_) { return { error: 'Could not reach the diary API.' }; }
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok || !data || !data.ok) return { error: (data && data.error) || `The diary API answered ${res.status}.` };
  state.days = data.days || {};
  return { timeZone: data.timeZone, reminders: data.reminders || [] };
}
const tallyInto = (c, list) => list.forEach(it => { c[it.cat] = (c[it.cat] || 0) + 1; });

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
  document.querySelectorAll('[role="menuitemradio"]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === prefs.theme)));
}
function savePrefs() { try { localStorage.setItem('diary-prefs-v2', JSON.stringify(prefs)); } catch (_) {} }
function setMenu(open) {
  $('#theme-menu').hidden = !open;
  $('#theme-btn').setAttribute('aria-expanded', String(open));
}

const ui = { range:'month', anchor:TODAY, tab:'all', openRaw:new Set(), openMove:new Set() };

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
    <div class="kpi"><b>${activeDays}</b><span>active days</span></div>
  </section>
  <section class="card">
    <div class="navrow">
      <div><span class="kicker">Activity</span><h2 style="margin:2px 0 0">${rangeLabel()}</h2></div>
      <div class="navrow" style="margin:0;gap:8px">
        <button class="btn" data-action="shift" data-v="-1" aria-label="Previous">‹</button>
        <button class="btn" data-action="shift" data-v="0">Today</button>
        <button class="btn" data-action="shift" data-v="1" aria-label="Next">›</button>
        <div class="seg">${seg}</div>
      </div>
    </div>
    ${stackChart(buckets(), 'Activity by category')}
    ${compHTML(counts)}
  </section>
  <section class="grid2">
    <div class="card"><span class="kicker">Calendar</span><h2>${y} at a glance</h2>${yearHeat(y)}</div>
    <div class="card"><span class="kicker">When you write</span><h2>Hour of day · all time</h2>${hourHistogram()}</div>
  </section>
  <section class="card"><span class="kicker">Folders</span><h2>${y}</h2><div class="folders">${months}</div></section>`;
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
  <section class="card"><span class="kicker">Days</span><h2>Folders</h2><div class="folders">${folders}</div></section>`;
}

function entryHTML(it, k) {
  const c = CAT[it.cat];
  const rawOpen = ui.openRaw.has(it.id), moveOpen = ui.openMove.has(it.id);
  const opts = CATS.map(x => `<option value="${x.id}"${x.id === it.cat ? ' selected' : ''}>${x.label}</option>`).join('');
  return `
    <article class="entry" style="--c:${c.color}">
      <div class="meta">
        <span class="time">${it.time}</span><span class="chip">${c.label}</span><span class="mode">${MODE_LABEL[it.mode]}</span>
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

function viewDay(y, m, d) {
  const k = `${y}-${pad(m)}-${pad(d)}`, date = parse(k), list = items(k);
  const counts = {}; tallyInto(counts, list);
  const shown = ui.tab === 'all' ? list : list.filter(it => it.cat === ui.tab);
  const tabDefs = [{ id:'all', label:'All', n:list.length }, ...CATS.map(c => ({ id:c.id, label:c.label, n:counts[c.id]||0 }))];
  const tabs = tabDefs.map(t => `<button class="tab${t.n ? '' : ' zero'}" role="tab" data-action="tab" data-v="${t.id}" aria-selected="${ui.tab===t.id}">${t.label}<small>${t.n}</small></button>`).join('');
  const strip = Array.from({ length:24 }, (_, h) => {
    const n = list.filter(it => +it.time.slice(0,2) === h).length;
    return `<div class="${n ? 'has' : ''}" style="height:${n ? Math.min(100, 18 + n * 22) : 4}%" title="${pad(h)}:00 · ${n}"></div>`;
  }).join('');
  const entries = shown.length ? shown.map(it => entryHTML(it, k)).join('') : '<p class="muted">Nothing here yet.</p>';
  const dayLink = dt => `#/y/${dt.getFullYear()}/m/${dt.getMonth()+1}/d/${dt.getDate()}`;
  return `
  <section class="hero"><span class="kicker">${list.length} items</span><h1>${fmtDay(date)}</h1>
    <div class="navrow" style="margin-top:10px;gap:8px">
      <a class="btn" href="${dayLink(addDays(date, -1))}">‹ Previous day</a>
      <a class="btn" href="${dayLink(addDays(date, 1))}">Next day ›</a>
    </div>
  </section>
  <section class="card"><span class="kicker">Categories</span><div class="tabs" role="tablist">${tabs}</div>${entries}</section>
  <section class="grid2">
    <div class="card"><span class="kicker">Timeline</span><h2>Hours</h2><div class="strip">${strip}</div><div class="ticks">${Array.from({length:24},(_,h)=>`<span>${h%3===0?pad(h):''}</span>`).join('')}</div></div>
    <div class="card"><span class="kicker">New note</span><h2>Add an item</h2>
      <form class="add" onsubmit="return false">
        <textarea id="add-text" placeholder="Type a thought, quote or note…"></textarea>
        <div class="row">
          <select id="add-mode"><option value="refined">Refined</option><option value="verbatim">Verbatim (/push)</option><option value="reason">Reason (/reason)</option><option value="think">Think (/think)</option></select>
          <select id="add-cat"><option value="">Auto (Inbox for now)</option>${CATS.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}</select>
          <button class="btn" type="button" data-action="add">Add</button>
        </div>
      </form>
      <p class="muted" style="margin:8px 0 0">Added here for this tab only. Send it in Telegram to keep it.</p>
    </div>
  </section>`;
}

function renderCrumbs(r) {
  let html = '<a href="#/">Home</a>';
  if (r.view !== 'home') html += `<span class="sep">/</span><a href="#/y/${r.y}/m/${r.m}">${MONTHS[r.m-1]} ${r.y}</a>`;
  if (r.view === 'day') html += `<span class="sep">/</span><span>${r.d}</span>`;
  $('#crumbs').innerHTML = html;
}
function render() {
  const r = route();
  renderCrumbs(r);
  if (r.view === 'day') ui.anchor = `${r.y}-${pad(r.m)}-${pad(r.d)}`;
  $('#app').innerHTML = r.view === 'home' ? viewHome() : r.view === 'month' ? viewMonth(r.y, r.m) : viewDay(r.y, r.m, r.d);
}
function shiftAnchor(n) {
  const a = parse(ui.anchor);
  if (ui.range === 'day') ui.anchor = iso(addDays(a, n));
  else if (ui.range === 'week') ui.anchor = iso(addDays(a, 7 * n));
  else if (ui.range === 'month') ui.anchor = iso(new Date(a.getFullYear(), a.getMonth() + n, 1));
  else ui.anchor = `${a.getFullYear() + n}-01-01`;
  if (ui.anchor > TODAY) ui.anchor = TODAY;
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
  state.days[k] = [...items(k), it].sort((a, b) => a.time.localeCompare(b.time));
  saveState(); render();
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-action]'); if (!t) return;
  const a = t.dataset.action, v = t.dataset.v;
  if (a === 'mode-toggle') { prefs.mode = prefs.mode === 'light' ? 'dark' : 'light'; applyPrefs(); savePrefs(); }
  else if (a === 'theme-menu') setMenu($('#theme-menu').hidden);
  else if (a === 'theme') { prefs.theme = v; applyPrefs(); savePrefs(); setMenu(false); }
  else if (a === 'range') { ui.range = v; render(); }
  else if (a === 'shift') { if (v === '0') ui.anchor = TODAY; else shiftAnchor(+v); render(); }
  else if (a === 'tab') { ui.tab = v; render(); }
  else if (a === 'raw') { ui.openRaw.has(v) ? ui.openRaw.delete(v) : ui.openRaw.add(v); render(); }
  else if (a === 'move') { ui.openMove.add(v); render(); }
  else if (a === 'add') addEntry();
});
document.addEventListener('change', e => {
  const s = e.target.closest('[data-move]'); if (!s) return;
  const [k, id] = s.dataset.move.split('|');
  const it = items(k).find(x => x.id === id);
  if (it) { it.cat = s.value; it.src = 'manual'; ui.openMove.delete(id); saveState(); render(); }
});
document.addEventListener('click', e => { if (!e.target.closest('.theme-wrap')) setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
window.addEventListener('hashchange', () => { ui.tab = 'all'; render(); window.scrollTo(0, 0); });

applyPrefs();
if (!location.hash) history.replaceState(null, '', '#/');
render();
loadDiary().then(r => {
  render();
  if (r.error) $('#app').insertAdjacentHTML('afterbegin', `<section class="card"><span class="kicker">Diary</span><p class="muted">${esc(r.error)}</p></section>`);
});
