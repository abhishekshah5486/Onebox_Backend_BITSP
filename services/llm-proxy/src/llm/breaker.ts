import type { Redis } from 'ioredis';

// After this many failures in a row a model is skipped for a while, across every replica.
const TRIP_AFTER = 3;
const OPEN_SECONDS = 60;
const COUNT_SECONDS = 300;

export function createBreaker(redis: Redis) {
  const failures = (model: string) => `llm:breaker:failures:${model}`;
  const open = (model: string) => `llm:breaker:open:${model}`;

  return {
    isOpen: async (model: string) => (await redis.exists(open(model))) === 1,

    async success(model: string) {
      await redis.del(failures(model));
    },

    // Returns true when this failure trips the breaker.
    async failure(model: string) {
      const count = await redis.incr(failures(model));
      await redis.expire(failures(model), COUNT_SECONDS);
      if (count < TRIP_AFTER) return false;
      await redis.set(open(model), '1', 'EX', OPEN_SECONDS);
      await redis.del(failures(model));
      return true;
    },
  };
}

export type Breaker = ReturnType<typeof createBreaker>;
