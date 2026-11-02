import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// The served page is a plain script, not a module the TypeScript tests can import, and a stray
// backtick inside one of its template strings is valid enough for `node --check` to pass while the
// page throws the moment it is drawn. So it is loaded in a stub browser and every page function is
// called: a ReferenceError here is the blank page the site would serve.
const source = readFileSync('public/app.js', 'utf8');

const noop = () => {};
const style = { setProperty: noop, removeProperty: noop, getPropertyValue: () => '' };
const element = () => ({
  style, textContent: '', innerHTML: '', hidden: false, dataset: {}, value: '',
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  setAttribute: noop, removeAttribute: noop, getAttribute: () => null, appendChild: noop,
  remove: noop, focus: noop, blur: noop, click: noop, replaceChildren: noop, scrollTo: noop,
  querySelector: () => null, querySelectorAll: () => [], addEventListener: noop,
  insertAdjacentHTML: noop, closest: () => null, scrollIntoView: noop,
});

function boot(hash) {
  const storage = new Map();
  const document = {
    querySelector: () => element(), querySelectorAll: () => [], getElementById: () => element(),
    createElement: element, createElementNS: element, createTextNode: element,
    addEventListener: noop, removeEventListener: noop, execCommand: () => true,
    documentElement: element(), body: element(), head: element(),
    fonts: { ready: Promise.resolve() }, cookie: '',
  };
  const ctx = createContext({
    console, document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    location: { hash, pathname: '/', search: '', href: 'https://ink.test/' + hash },
    history: { replaceState: noop, pushState: noop },
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    // A pending promise keeps the page's own load quiet, so the only thing this check can
    // fail on is the drawing itself.
    fetch: () => new Promise(() => {}),
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Date, Math, JSON, Intl, URL, URLSearchParams, Promise, Number, String, Object, Array, RegExp,
    addEventListener: noop, removeEventListener: noop, getComputedStyle: () => ({ getPropertyValue: () => '' }),
    alert: noop, confirm: () => false, prompt: () => null,
    crypto: globalThis.crypto, requestAnimationFrame: (f) => setTimeout(f, 0),
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  runInContext(source, ctx, { filename: 'public/app.js' });
  return ctx;
}

const draw = (hash, fn) => runInContext(`${fn}()`, boot(hash));

describe('the served pages draw', () => {
  it('sends #/settings/connect to the Connect page', () => {
    const ctx = boot('#/settings/connect');
    expect(runInContext('route().view', ctx)).toBe('connect');
  });

  it('draws Connect, prompt and key card included', () => {
    const html = draw('#/settings/connect', 'viewConnect');
    expect(typeof html).toBe('string');
    expect(html).toContain('Paste this into the agent');
    expect(html).toContain('id="keys-card"');
    expect(html).toContain('commands/');
  });

  it('draws Settings and Look without throwing', () => {
    expect(draw('#/settings', 'viewSettings')).toContain('Preferences');
    expect(draw('#/settings/look', 'viewLook')).toContain('<section');
  });
});
