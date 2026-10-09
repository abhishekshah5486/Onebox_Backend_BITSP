import { pino, stdSerializers, stdTimeFunctions, type DestinationStream, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
}

const SECRET_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
];

export const REDACT_PATHS = [
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(options: LoggerOptions, destination?: DestinationStream): Logger {
  const transport =
    options.pretty && !destination
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined;

  return pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service },
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      // Wrapped errors (e.g. driver errors inside query errors) keep their root cause in the log.
      serializers: { err: stdSerializers.errWithCause },
      ...(transport && { transport }),
    },
    destination,
  );
}
