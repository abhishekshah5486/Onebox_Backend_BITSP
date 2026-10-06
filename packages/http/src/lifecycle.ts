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

export async function startServer(
  app: HttpServer,
  { port, host = '0.0.0.0', cleanups = [] }: { port: number; host?: string; cleanups?: Cleanup[] },
) {
  const shutdown = createShutdown(app, cleanups);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal).then(() => process.exit(0)));
  }
  await app.listen({ port, host });
  return shutdown;
}
