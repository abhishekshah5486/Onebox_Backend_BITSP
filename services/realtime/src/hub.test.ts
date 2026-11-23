import { describe, expect, it, vi } from 'vitest';
import { createHub } from './hub';

describe('hub', () => {
  it("delivers to each of a user's streams and no one else's", () => {
    const hub = createHub();
    const [a, b, other] = [vi.fn(), vi.fn(), vi.fn()];
    hub.add('u1', a);
    hub.add('u1', b);
    hub.add('u2', other);

    expect(hub.deliver('u1', 'x')).toBe(2);
    expect(a).toHaveBeenCalledWith('x');
    expect(b).toHaveBeenCalledWith('x');
    expect(other).not.toHaveBeenCalled();

    hub.remove('u1', a);
    hub.remove('u1', b);
    expect(hub.deliver('u1', 'y')).toBe(0);
    expect(hub.size).toBe(1);
  });

  it('caps the streams one user can hold open', () => {
    const hub = createHub({ maxPerUser: 1 });
    expect(hub.add('u1', vi.fn())).toBe(true);
    expect(hub.add('u1', vi.fn())).toBe(false);
  });
});
