import type { HttpServer } from './create-server';

export type HealthCheck = () => Promise<unknown>;

const CHECK_TIMEOUT_MS = 5000;

async function runCheck(check: HealthCheck): Promise<'up' | 'down'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timed out')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

// live = process is running; ready = every dependency answered, so traffic can be routed here.
export function registerHealthRoutes(app: HttpServer, checks: Record<string, HealthCheck> = {}) {
  app.get('/health/live', async () => ({ status: 'ok' }));

  app.get('/health/ready', async (request, reply) => {
    const names = Object.keys(checks);
    const results = await Promise.all(names.map((name) => runCheck(checks[name]!)));
    const report = Object.fromEntries(names.map((name, i) => [name, results[i]]));
    const ready = results.every((status) => status === 'up');
    if (!ready) request.log.warn({ checks: report }, 'readiness check failed');
    return reply
      .status(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'unavailable', checks: report });
  });
}
