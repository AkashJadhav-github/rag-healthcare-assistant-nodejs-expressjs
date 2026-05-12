import winston, { Logger, LoggerOptions, format, transports } from 'winston';

// Lazily import winston-elasticsearch so the app still boots when
// ELASTICSEARCH_URL is not set (the package may not be installed in all envs).
// We use a dynamic require inside the factory to avoid a top-level crash.

// ---------------------------------------------------------------------------
// Environment helpers (reproduced here to avoid circular dep with config.ts)
// ---------------------------------------------------------------------------

const NODE_ENV = process.env.NODE_ENV ?? 'development';
const isDev = NODE_ENV === 'development';
const ELASTICSEARCH_URL = process.env.ELASTICSEARCH_URL;
const SERVICE_NAME = process.env.SERVICE_NAME ?? 'rag-healthcare-assistant';

// ---------------------------------------------------------------------------
// Shared formats
// ---------------------------------------------------------------------------

const jsonFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  format.errors({ stack: true }),
  format.splat(),
  format.json()
);

const prettyFormat = format.combine(
  format.colorize({ all: true }),
  format.timestamp({ format: 'HH:mm:ss' }),
  format.errors({ stack: true }),
  format.printf(({ timestamp, level, message, context, stack, ...meta }) => {
    const ctx = context ? `[${context}] ` : '';
    const metaStr =
      Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    const stackStr = stack ? `\n${stack}` : '';
    return `${timestamp} ${level} ${ctx}${message}${metaStr}${stackStr}`;
  })
);

// ---------------------------------------------------------------------------
// Transport builders
// ---------------------------------------------------------------------------

function buildTransports(context?: string): winston.transport[] {
  const list: winston.transport[] = [];

  // Console
  list.push(
    new transports.Console({
      format: isDev ? prettyFormat : jsonFormat,
      handleExceptions: true,
      handleRejections: true,
    })
  );

  // File transports (skip in test to avoid littering the workspace)
  if (NODE_ENV !== 'test') {
    list.push(
      new transports.File({
        filename: 'logs/error.log',
        level: 'error',
        format: jsonFormat,
        maxsize: 10 * 1024 * 1024, // 10 MB
        maxFiles: 5,
        tailable: true,
      }),
      new transports.File({
        filename: 'logs/combined.log',
        format: jsonFormat,
        maxsize: 20 * 1024 * 1024, // 20 MB
        maxFiles: 10,
        tailable: true,
      })
    );
  }

  // Elasticsearch transport (optional)
  if (ELASTICSEARCH_URL) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ElasticsearchTransport } = require('winston-elasticsearch');
      const esTransportOpts = {
        level: 'info',
        clientOpts: { node: ELASTICSEARCH_URL },
        indexPrefix: 'rag-healthcare-logs',
        indexSuffixPattern: 'YYYY.MM.DD',
        messageType: '_doc',
        ensureMappingTemplate: true,
        flushInterval: 2000,
        transformer: (logData: {
          message: string;
          level: string;
          meta: Record<string, unknown>;
        }) => ({
          '@timestamp': new Date().toISOString(),
          severity: logData.level,
          message: logData.message,
          service: SERVICE_NAME,
          context: context ?? 'root',
          ...logData.meta,
        }),
      };
      list.push(new ElasticsearchTransport(esTransportOpts));
    } catch {
      // winston-elasticsearch not installed — silently skip
    }
  }

  return list;
}

// ---------------------------------------------------------------------------
// Base options
// ---------------------------------------------------------------------------

function buildOptions(context?: string): LoggerOptions {
  return {
    level: isDev ? 'debug' : 'info',
    defaultMeta: {
      service: SERVICE_NAME,
      ...(context ? { context } : {}),
    },
    transports: buildTransports(context),
    exitOnError: false,
  };
}

// ---------------------------------------------------------------------------
// Default (root) logger
// ---------------------------------------------------------------------------

const logger: Logger = winston.createLogger(buildOptions());

// ---------------------------------------------------------------------------
// createLogger — returns a child logger stamped with a context label
// ---------------------------------------------------------------------------

/**
 * Create a named child logger for a specific module / service context.
 *
 * @example
 * const log = createLogger('QueryService');
 * log.info('Processing query', { queryId });
 */
export function createLogger(context: string): Logger {
  return logger.child({ context });
}

// ---------------------------------------------------------------------------
// Stream adapter for Morgan HTTP access logs
// ---------------------------------------------------------------------------

export const httpLogStream = {
  write: (message: string): void => {
    logger.http(message.trimEnd());
  },
};

export default logger;
