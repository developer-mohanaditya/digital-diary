import { describe, expect, it, vi } from 'vitest';
import { handleUpdate, localDay, type Store, type Notifier, type TelegramUpdate } from '../src/handler';
import type { Refiner } from '../src/refine';

const SETTINGS = { allowedChatId: 42, timeZone: 'UTC' };
const NOW = new Date('2026-10-13T10:00:00Z');

function fakeStore(overrides: Partial<Store> = {}) {
  const store: Store = {
    insertCapture: vi.fn(async () => ({ inserted: true, id: 'cap-1' })),
    insertThought: vi.fn(async () => {}),
    setCaptureStatus: vi.fn(async () => {}),
    getTimeZone: vi.fn(async () => null),
    setTimeZone: vi.fn(async () => {}),
    ...overrides,
  };
  return store;
}
const fakeNotifier = () => ({ reply: vi.fn(async () => {}) }) as Notifier & { reply: ReturnType<typeof vi.fn> };
const update = (text: string | undefined, chat = 42, update_id = 100): TelegramUpdate => ({
  update_id, message: { message_id: 1, date: 1791895200, text, chat: { id: chat } },
});

describe('handleUpdate', () => {
  it('/start replies with help and stores nothing as a diary entry', async () => {
    const store = fakeStore(); const n = fakeNotifier();
    expect(await handleUpdate(update('/start'), store, n, SETTINGS, NOW)).toBe('ignored');
    expect(store.insertCapture).not.toHaveBeenCalled();
    expect(store.insertThought).not.toHaveBeenCalled();
    expect(n.reply.mock.calls[0][1]).toContain('Send any note');
  });

  it('/test replies with database stats and stores nothing', async () => {
    const store = fakeStore({
      health: vi.fn(async () => ({
        captures: 5, thoughts: 4, todayThoughts: 2, pendingReminders: 1,
        lastCaptureAt: '2026-10-13T09:12:00Z', heartbeatOk: true,
      })),
    });
    const n = fakeNotifier();
    expect(await handleUpdate(update('/test'), store, n, SETTINGS, NOW)).toBe('ignored');
    expect(store.insertCapture).not.toHaveBeenCalled();
    const text = n.reply.mock.calls[0][1] as string;
    expect(text).toContain('Database ok.');
    expect(text).toContain('Entries 4 (2 today)');
    expect(text).toContain('Reminders pending 1');
    expect(text).toContain('Heartbeat written.');
  });

  it('/test reports the real error instead of staying silent', async () => {
    const store = fakeStore({
      health: vi.fn(async () => { throw new Error('Supabase 401: invalid api key'); }),
    });
    const n = fakeNotifier();
    expect(await handleUpdate(update('/test'), store, n, SETTINGS, NOW)).toBe('ignored');
    expect(n.reply.mock.calls[0][1]).toContain('Database check failed');
    expect(n.reply.mock.calls[0][1]).toContain('Supabase 401');
  });

  it('/test still replies when reading the timezone fails', async () => {
    const store = fakeStore({
      getTimeZone: vi.fn(async () => { throw new Error('fetch failed: invalid URL'); }),
      health: vi.fn(async () => ({
        captures: 0, thoughts: 0, todayThoughts: 0, pendingReminders: 0,
        lastCaptureAt: null, heartbeatOk: true,
      })),
    });
    const n = fakeNotifier();
    expect(await handleUpdate(update('/test'), store, n, SETTINGS, NOW)).toBe('ignored');
    expect(n.reply.mock.calls[0][1]).toContain('Database check failed');
    expect(n.reply.mock.calls[0][1]).toContain('invalid URL');
  });

  it('ignores messages from any chat other than the owner', async () => {
    const store = fakeStore(); const n = fakeNotifier();
    expect(await handleUpdate(update('hi', 999), store, n, SETTINGS, NOW)).toBe('ignored');
    expect(store.insertCapture).not.toHaveBeenCalled();
  });

  it('stores the raw capture before any thought, then marks it done', async () => {
    const calls: string[] = [];
    const store = fakeStore({
      insertCapture: vi.fn(async () => { calls.push('capture'); return { inserted: true, id: 'cap-1' }; }),
      insertThought: vi.fn(async () => { calls.push('thought'); }),
      setCaptureStatus: vi.fn(async () => { calls.push('done'); }),
    });
    await handleUpdate(update('/push /thought Stay hungry'), store, fakeNotifier(), SETTINGS, NOW);
    expect(calls).toEqual(['capture', 'thought', 'done']);
  });

  it('saves /push /thought verbatim into Thought with source "tag"', async () => {
    const store = fakeStore(); const n = fakeNotifier();
    expect(await handleUpdate(update('/push /thought Stay hungry, stay foolish'), store, n, SETTINGS, NOW)).toBe('saved');
    expect(store.insertThought).toHaveBeenCalledWith(expect.objectContaining({
      capture_id: 'cap-1', day: '2026-10-13', category: 'thought', category_source: 'tag',
      mode: 'verbatim', clean_text: 'Stay hungry, stay foolish', raw_text: 'Stay hungry, stay foolish',
    }));
    expect(n.reply).toHaveBeenCalledWith(42, 'Saved to Thought.');
  });

  it('untagged text goes to Inbox with source "auto"', async () => {
    const store = fakeStore();
    await handleUpdate(update('an idea about reviews'), store, fakeNotifier(), SETTINGS, NOW);
    expect(store.insertThought).toHaveBeenCalledWith(expect.objectContaining({ category: 'inbox', category_source: 'auto' }));
  });

  it('a conflict is stored as failed, nothing becomes a thought, and the user is asked', async () => {
    const store = fakeStore(); const n = fakeNotifier();
    expect(await handleUpdate(update('/push /think hi'), store, n, SETTINGS, NOW)).toBe('rejected');
    expect(store.insertThought).not.toHaveBeenCalled();
    expect(store.setCaptureStatus).toHaveBeenCalledWith('cap-1', 'failed', 'conflict_mode');
    expect(n.reply.mock.calls[0][1]).toContain('Pick one mode');
  });

  it('a duplicate Telegram update is ignored: no thought, no reply', async () => {
    const store = fakeStore({ insertCapture: vi.fn(async () => ({ inserted: false })) }); const n = fakeNotifier();
    expect(await handleUpdate(update('hi'), store, n, SETTINGS, NOW)).toBe('duplicate');
    expect(store.insertThought).not.toHaveBeenCalled();
    expect(n.reply).not.toHaveBeenCalled();
  });

  it('rethrows storage errors so the webhook can ask Telegram to retry', async () => {
    const store = fakeStore({ insertThought: vi.fn(async () => { throw new Error('db down'); }) });
    await expect(handleUpdate(update('hi'), store, fakeNotifier(), SETTINGS, NOW)).rejects.toThrow('db down');
  });

  it('voice and photos get a clear reply for now', async () => {
    const store = fakeStore(); const n = fakeNotifier();
    expect(await handleUpdate(update(undefined), store, n, SETTINGS, NOW)).toBe('ignored');
    expect(n.reply.mock.calls[0][1]).toContain('not wired up');
  });
});

describe('cleanup', () => {
  function fakeRefiner(answer: string | null | Error) {
    const refine = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    return { refiner: { refine } as Refiner, refine };
  }

  it('stores the cleaned text and keeps the original beside it', async () => {
    const store = fakeStore(); const n = fakeNotifier();
    const { refiner, refine } = fakeRefiner('Had coffee with Ram.');
    expect(await handleUpdate(update('um so i had a coffee with ram, yeah'), store, n, SETTINGS, NOW, refiner)).toBe('saved');
    expect(refine).toHaveBeenCalledWith({ text: 'um so i had a coffee with ram, yeah', mode: 'refine', category: 'inbox' });
    expect(store.insertThought).toHaveBeenCalledWith(expect.objectContaining({
      clean_text: 'Had coffee with Ram.',
      raw_text: 'um so i had a coffee with ram, yeah',
    }));
    expect(n.reply).toHaveBeenCalledWith(42, 'Saved to Inbox.');
  });

  it('sends the tagged category and the mode it was sent with', async () => {
    const store = fakeStore();
    const { refiner, refine } = fakeRefiner('A tighter paragraph.');
    await handleUpdate(update('/work /reason the api fix went out but nobody checked it'), store, fakeNotifier(), SETTINGS, NOW, refiner);
    expect(refine).toHaveBeenCalledWith(expect.objectContaining({ mode: 'reason', category: 'work' }));
  });

  it('never cleans up a verbatim note: the exact words are the point', async () => {
    const store = fakeStore();
    const { refiner, refine } = fakeRefiner('rewritten');
    await handleUpdate(update('/push /work Shipped the entries fix.'), store, fakeNotifier(), SETTINGS, NOW, refiner);
    expect(refine).not.toHaveBeenCalled();
    expect(store.insertThought).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'verbatim', clean_text: 'Shipped the entries fix.', raw_text: 'Shipped the entries fix.',
    }));
  });

  it('saves the note as written and says so when the model fails', async () => {
    const store = fakeStore(); const n = fakeNotifier();
    const { refiner } = fakeRefiner(new Error('AI quota exhausted'));
    expect(await handleUpdate(update('a quick note'), store, n, SETTINGS, NOW, refiner)).toBe('saved');
    expect(store.insertThought).toHaveBeenCalledWith(expect.objectContaining({
      clean_text: 'a quick note', raw_text: 'a quick note',
    }));
    expect(store.setCaptureStatus).toHaveBeenCalledWith('cap-1', 'done');
    expect(n.reply.mock.calls[0][1]).toContain('Cleanup failed');
    // The reason travels with the reply: "failed" alone cannot be diagnosed from a phone.
    expect(n.reply.mock.calls[0][1]).toContain('AI quota exhausted');
  });

  it('keeps the original silently when the model returns nothing', async () => {
    const store = fakeStore(); const n = fakeNotifier();
    const { refiner } = fakeRefiner(null);
    await handleUpdate(update('a quick note'), store, n, SETTINGS, NOW, refiner);
    expect(store.insertThought).toHaveBeenCalledWith(expect.objectContaining({
      clean_text: 'a quick note', raw_text: 'a quick note',
    }));
    expect(n.reply.mock.calls[0][1]).not.toContain('Cleanup failed');
  });

  it('without a refiner the note is stored as written, as before', async () => {
    const store = fakeStore();
    await handleUpdate(update('no model here'), store, fakeNotifier(), SETTINGS, NOW);
    expect(store.insertThought).toHaveBeenCalledWith(expect.objectContaining({
      clean_text: 'no model here', raw_text: 'no model here',
    }));
  });
});

describe('localDay', () => {
  it('uses the diary timezone, not UTC', () => {
    const late = new Date('2026-10-13T23:30:00Z');
    expect(localDay(late, 'UTC')).toBe('2026-10-13');
    expect(localDay(late, 'Asia/Kolkata')).toBe('2026-10-14');
  });
});

describe('timezone handling', () => {
  function tzStore(zone: string | null) {
    return fakeStore({ getTimeZone: vi.fn(async () => zone) });
  }

  it('/timezone with a name stores it and confirms, without making a thought', async () => {
    const store = tzStore('Europe/Paris'); const n = fakeNotifier();
    expect(await handleUpdate(update('/timezone Asia/Kolkata'), store, n, SETTINGS, NOW)).toBe('saved');
    expect(store.setTimeZone).toHaveBeenCalledWith('Asia/Kolkata');
    expect(store.insertThought).not.toHaveBeenCalled();
    expect(store.setCaptureStatus).toHaveBeenCalledWith('cap-1', 'done');
    expect(n.reply.mock.calls[0][1]).toContain('Timezone set to Asia/Kolkata');
  });

  it('/timezone alone shows the current zone', async () => {
    const store = tzStore('Europe/Paris'); const n = fakeNotifier();
    await handleUpdate(update('/timezone'), store, n, SETTINGS, NOW);
    expect(store.setTimeZone).not.toHaveBeenCalled();
    expect(n.reply.mock.calls[0][1]).toBe('Your timezone is Europe/Paris.');
  });

  it('an unknown zone is refused and nothing is stored', async () => {
    const store = tzStore('Europe/Paris'); const n = fakeNotifier();
    await handleUpdate(update('/timezone Mars/Olympus'), store, n, SETTINGS, NOW);
    expect(store.setTimeZone).not.toHaveBeenCalled();
    expect(n.reply.mock.calls[0][1]).toContain('is not a timezone I know');
  });

  it('new entries use the stored zone, not the default', async () => {
    // 23:30 UTC is already the next day in Asia/Kolkata (+05:30).
    const store = tzStore('Asia/Kolkata');
    const late = { update_id: 7, message: { message_id: 2, date: Date.parse('2026-10-13T23:30:00Z') / 1000, text: 'late thought', chat: { id: 42 } } };
    await handleUpdate(late, store, fakeNotifier(), { allowedChatId: 42, timeZone: 'Europe/Paris' }, new Date('2026-10-13T23:30:00Z'));
    expect(store.insertThought).toHaveBeenCalledWith(expect.objectContaining({ day: '2026-10-14' }));
  });
});
