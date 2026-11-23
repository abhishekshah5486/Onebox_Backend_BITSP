// Each user's open streams; an event for a user goes to every app they have open.
export type Send = (data: string) => void;

export function createHub({ maxPerUser = 10 }: { maxPerUser?: number } = {}) {
  const streams = new Map<string, Set<Send>>();

  return {
    // False when the user already has too many open, so a leaking client can't pile them up.
    add(userId: string, send: Send) {
      const mine = streams.get(userId) ?? new Set<Send>();
      if (mine.size >= maxPerUser) return false;
      mine.add(send);
      streams.set(userId, mine);
      return true;
    },
    remove(userId: string, send: Send) {
      const mine = streams.get(userId);
      mine?.delete(send);
      if (mine?.size === 0) streams.delete(userId);
    },
    deliver(userId: string, data: string) {
      const mine = streams.get(userId);
      for (const send of mine ?? []) send(data);
      return mine?.size ?? 0;
    },
    get size() {
      let total = 0;
      for (const mine of streams.values()) total += mine.size;
      return total;
    },
  };
}

export type Hub = ReturnType<typeof createHub>;
