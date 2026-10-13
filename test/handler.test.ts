import { describe, expect, it, vi } from 'vitest';
import { handleUpdate, localDay, type Store, type Notifier, type TelegramUpdate } from '../src/handler';

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
