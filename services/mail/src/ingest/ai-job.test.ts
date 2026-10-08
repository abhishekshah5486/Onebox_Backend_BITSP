import { describe, expect, it } from 'vitest';
import { freshText } from './ai-job';

describe('freshText', () => {
  it('keeps only the new part of a reply', () => {
    expect(
      freshText(
        'Sounds good, Tuesday works.\n\nOn Tue, Oct 6, 2026 at 10:00 Priya wrote:\n> Are you free?',
      ),
    ).toBe('Sounds good, Tuesday works.');
    expect(freshText('Hi\n> quoted\nThanks')).toBe('Hi\nThanks');
  });
});
