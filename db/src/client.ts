import pg from 'pg';

export interface PoolOptions {
  connectionString: string;
  max?: number;
  /** Required outside local development. */
  ssl?: boolean;
  /**
   * Told when an idle connection fails — the database restarted, the network
   * dropped, a pooler closed it. The pool has already discarded that
   * connection; the next checkout opens a new one.
   */
  onError?: (error: Error) => void;
}

/**
 * How long a checkout may wait for a connection before it fails. Without it a
 * database that accepts no connections holds every request until the host
 * kills it, minutes later; with it the caller gets a 503 in seconds.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * An idle connection is kept this long before it is closed. Opening one to a
 * managed database costs a TLS handshake and an authentication exchange — more
 * than most queries — so a connection that outlives a reader's pause between
 * two clicks is worth more than the socket it holds.
 */
const IDLE_TIMEOUT_MS = 60_000;

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    // The operating system notices a peer that went away without closing,
    // rather than the next query finding out.
    keepAlive: true,
    ...(options.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  });

  // An idle connection that fails is emitted here, and an 'error' event with
  // no listener is thrown — it would end the process, and every request in
  // flight with it, over a connection nobody was using.
  pool.on('error', (error) => {
    if (options.onError) options.onError(error);
    else
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'warn',
          msg: 'idle database connection failed',
          err: error.message,
        }) + '\n',
      );
  });

  return pool;
}
