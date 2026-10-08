import { describe, expect, it } from 'vitest';
import { checkLabelName } from './label-service';

describe('checkLabelName', () => {
  it('tidies nesting and rejects names the server reserves', () => {
    expect(checkLabelName('  Work / Clients ')).toBe('Work/Clients');
    expect(() => checkLabelName('INBOX/x')).toThrow(/reserved/);
    expect(() => checkLabelName('[Gmail]')).toThrow(/reserved/);
    expect(() => checkLabelName('Work//x')).toThrow(/between/);
    expect(() => checkLabelName('   ')).toThrow(/1 to 200/);
  });
});
