// Handling for the /timezone command, e.g. "/timezone Asia/Kolkata".

export type TimeZoneCommand =
  | { kind: 'show' }
  | { kind: 'set'; zone: string }
  | { kind: 'invalid'; input: string };

const COMMAND = /^\s*\/timezone(?:\s+(\S+))?\s*$/i;

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Returns null when the message is not a /timezone command.
export function parseTimeZoneCommand(text: string): TimeZoneCommand | null {
  const m = COMMAND.exec(text);
  if (!m) return null;
  if (m[1] === undefined) return { kind: 'show' };
  const zone = m[1];
  return isValidTimeZone(zone) ? { kind: 'set', zone } : { kind: 'invalid', input: zone };
}
