import pino from 'pino';

// stdout is reserved for CLI output; all diagnostic logging goes to stderr.
const transport =
  process.env['NODE_ENV'] !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, destination: 2 } }
    : undefined;

const rootLogger = pino({ level: 'info', transport }, pino.destination(2));

export function createComponentLogger(component: string): pino.Logger {
  return rootLogger.child({ component });
}
