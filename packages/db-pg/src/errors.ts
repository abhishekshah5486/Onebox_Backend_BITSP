// Drizzle wraps driver errors, so the Postgres code may sit on the error or its cause.
export function isUniqueViolation(err: unknown): boolean {
  return [err, (err as { cause?: unknown } | undefined)?.cause].some(
    (e) => (e as { code?: string } | undefined)?.code === '23505',
  );
}
