import { describe, expect, it } from 'vitest';
import { detectReminder } from '../src/reminders';

const NOW = new Date('2026-10-23T09:00:00Z');

describe('detectReminder', () => {
  it('explicit /deadline creates deadline with due date', () => {
    const r = detectReminder('/deadline finish assignment by 3rd nov', NOW, 'UTC');
    expect(r?.kind).toBe('deadline');
    expect(r?.dueAt).toContain('11-03');
    expect(r?.source).toBe('explicit');
  });
  it('implicit context in 3 days becomes deadline', () => {
    const r = detectReminder('Complete project report in 3 days', NOW, 'UTC');
    expect(r?.kind).toBe('deadline');
  });
  it('review phrases become evening review', () => {
    const r = detectReminder('Just spoke to x, need to review it later', NOW, 'UTC');
    expect(r?.kind).toBe('review');
    expect(r?.nextRemindAt).toBeDefined();
  });
  it('plain note returns null', () => {
    expect(detectReminder('had coffee with ram', NOW, 'UTC')).toBeNull();
  });
});
