import { describe, expect, it } from 'vitest';
import { hashPassphrase, passphraseProblem, verifyPassphrase } from '../src/auth';

describe('hashPassphrase', () => {
  it('writes a self-describing PBKDF2 string, never the passphrase', async () => {
    const hash = await hashPassphrase('correct horse battery');
    expect(hash).toMatch(/^pbkdf2\$sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('salts, so the same passphrase hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassphrase('twelve chars'), hashPassphrase('twelve chars')]);
    expect(a).not.toBe(b);
    expect(await verifyPassphrase('twelve chars', a)).toBe(true);
    expect(await verifyPassphrase('twelve chars', b)).toBe(true);
  });
});

describe('verifyPassphrase', () => {
  it('accepts the passphrase it was made from and nothing else', async () => {
    const hash = await hashPassphrase('open sesame');
    expect(await verifyPassphrase('open sesame', hash)).toBe(true);
    expect(await verifyPassphrase('open sésame', hash)).toBe(false);
    expect(await verifyPassphrase('', hash)).toBe(false);
  });

  it('refuses a malformed or truncated hash instead of throwing', async () => {
    for (const bad of ['', 'nonsense', 'pbkdf2$sha256$100000$only-four', 'sha256$pbkdf2$100000$a$b',
      'pbkdf2$sha256$0$AAAA$AAAA', 'pbkdf2$sha256$100000$AAAA$AAAA', 'pbkdf2$sha512$100000$AAAA$AAAA']) {
      expect(await verifyPassphrase('anything', bad)).toBe(false);
    }
  });
});

describe('passphraseProblem', () => {
  it('asks for eight characters, a different value, and something sane in length', () => {
    expect(passphraseProblem('short', 'old')).toBe('Use at least eight characters.');
    expect(passphraseProblem('x'.repeat(201), 'old')).toContain('too long');
    expect(passphraseProblem('same as old', 'same as old')).toBe('That is the passphrase you already have.');
    expect(passphraseProblem('a good new one', 'old')).toBeNull();
  });
});
