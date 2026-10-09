import type { HttpServer } from './create-server';

export type Cleanup = () => Promise<unknown>;

export function createShutdown(app: HttpServer, cleanups: Cleanup[] = []) {
  let closing: Promise<void> | undefined;
  return (signal: string) => {
    closing ??= (async () => {
      app.log.info({ signal }, 'shutting down');
      await app.close();
      for (const cleanup of cleanups) {
        await cleanup().catch((err: unknown) => app.log.error({ err }, 'cleanup failed'));
      }
      app.log.info('shutdown complete');
    })();
    return closing;
  };
}

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
]);

// A dropped or unreachable connection (e.g. to a remote database); the next request reconnects.
export const isTransientNetworkError = (err: unknown) =>
  TRANSIENT_CODES.has((err as { code?: unknown } | null)?.code as string);

export async function startServer(
  app: HttpServer,
  { port, host = '0.0.0.0', cleanups = [] }: { port: number; host?: string; cleanups?: Cleanup[] },
) {
  const shutdown = createShutdown(app, cleanups);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal).then(() => process.exit(0)));
  }
  // A connection dropping with nothing awaiting it should not take the whole service down; any
  // other unhandled failure still crashes it, so it restarts from a clean state.
  process.on('unhandledRejection', (err) => {
    if (!isTransientNetworkError(err)) throw err;
    app.log.warn({ err }, 'connection dropped outside a request');
  });
  await app.listen({ port, host });
  return shutdown;
}
