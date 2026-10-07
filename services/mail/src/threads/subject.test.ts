import { describe, expect, it } from 'vitest';
import { isReplySubject, normalizeSubject } from './subject';

describe('normalizeSubject', () => {
  it.each([
    ['Demo next week', 'demo next week'],
    ['Re: Demo next week', 'demo next week'],
    ['RE: Fwd: re:  Demo   next week ', 'demo next week'],
    ['Re[2]: Demo next week', 'demo next week'],
    ['AW: WG: Demo next week', 'demo next week'],
    ['[External] Re: Demo next week', 'demo next week'],
    ['', ''],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeSubject(input)).toBe(expected);
  });

  it('keeps words that merely start like a prefix', () => {
    expect(normalizeSubject('Revenue report')).toBe('revenue report');
  });
});

describe('isReplySubject', () => {
  it('recognises reply and forward prefixes only', () => {
    expect(isReplySubject('Re: hi')).toBe(true);
    expect(isReplySubject('Fwd: hi')).toBe(true);
    expect(isReplySubject('Revenue report')).toBe(false);
  });
});
