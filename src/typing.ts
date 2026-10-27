// Telegram's "typing…" is a chat action, and it lapses about five seconds after it is sent. So one
// goes out the moment an update lands, and it is refreshed while the note is still being cleaned
// and stored: a few seconds of work then looks like work, instead of looking like a message that
// never arrived. The reply itself clears the indicator.
import type { Notifier } from './handler';

// Comfortably inside Telegram's five-second lapse, so there is never a gap where it has expired.
export const TYPING_EVERY_MS = 4000;
// A run that hangs must not ping for ever; after this the indicator is allowed to lapse, and the
// webhook's own error path answers with what went wrong.
export const TYPING_GIVE_UP_MS = 80_000;

export interface TypingLoop {
  // Called as soon as the reply is on its way, or the update has failed and been answered.
  stop(): void;
}

// Starts the indicator and keeps it alive until stop(). Never throws and never rejects: the note
// is what matters, and a chat action is not worth failing one over. A notifier with no typing port
// — a test double, another adapter — simply gets none of this.
export async function keepTyping(
  notifier: Notifier,
  chatId: number,
  everyMs = TYPING_EVERY_MS,
  giveUpMs = TYPING_GIVE_UP_MS,
): Promise<TypingLoop> {
  if (!notifier.typing) return { stop() {} };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();

  const ping = async () => {
    try {
      await notifier.typing?.(chatId);
    } catch {
      // Swallowed on purpose: a failed chat action is invisible to the reader anyway, and
      // logging it once per refresh would bury the errors that do matter.
    }
  };

  // Awaited, so the indicator is showing before the slow part — the cleanup and the two writes —
  // begins, rather than racing it.
  await ping();

  const again = () => {
    if (stopped || Date.now() - startedAt >= giveUpMs) return;
    timer = setTimeout(() => { void ping().then(again); }, everyMs);
  };
  again();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
