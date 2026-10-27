import { describe, expect, it, vi } from 'vitest';
import { TYPING_EVERY_MS, TYPING_GIVE_UP_MS, keepTyping } from '../src/typing';
import type { Notifier } from '../src/handler';

const notifier = () => {
  const typing = vi.fn(async (_chatId: number) => {});
  return { n: { reply: vi.fn(async () => {}), typing } as Notifier, typing };
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('keepTyping', () => {
  it('refreshes inside Telegram\'s five-second lapse', () => {
    expect(TYPING_EVERY_MS).toBeLessThan(5000);
    expect(TYPING_GIVE_UP_MS).toBeGreaterThan(TYPING_EVERY_MS);
  });

  it('is already showing when it hands back, so the slow part comes after it', async () => {
    const { n, typing } = notifier();
    const loop = await keepTyping(n, 42);
    expect(typing).toHaveBeenCalledWith(42);
    loop.stop();
  });

  it('keeps refreshing while the note is still being cleaned and stored', async () => {
    const { n, typing } = notifier();
    const loop = await keepTyping(n, 42, 5);
    await wait(60);
    expect(typing.mock.calls.length).toBeGreaterThan(2);
    loop.stop();
  });

  it('goes quiet the moment the reply is on its way', async () => {
    const { n, typing } = notifier();
    const loop = await keepTyping(n, 42, 5);
    await wait(20);
    loop.stop();
    const settled = typing.mock.calls.length;
    await wait(40);
    expect(typing.mock.calls.length).toBe(settled);
  });

  it('lets a hung task lapse instead of typing for ever', async () => {
    const { n, typing } = notifier();
    const loop = await keepTyping(n, 42, 5, 20);
    await wait(80);
    // The first ping plus a few refreshes, then the cap. Uncapped this would be ~17.
    expect(typing.mock.calls.length).toBeLessThanOrEqual(6);
    loop.stop();
  });

  it('never lets the indicator fail the note', async () => {
    const n: Notifier = {
      reply: vi.fn(async () => {}),
      typing: vi.fn(async (_chatId: number) => { throw new Error('telegram is down'); }),
    };
    const loop = await keepTyping(n, 42, 5);
    await wait(20);
    loop.stop();
  });

  it('is a no-op for a notifier that has no typing port', async () => {
    const n: Notifier = { reply: vi.fn(async () => {}) };
    const loop = await keepTyping(n, 42, 5);
    await wait(10);
    loop.stop();
  });
});
