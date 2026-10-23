/**
 * Optional distributed rate-limit counter store. This module is not a memory
 * store or general-purpose application cache. Memory and embeddings must never
 * import it. Disabled unless HELIUM_REDIS_ENABLED=true and REDIS_URL are set.
 */
import { Logger } from '../core/Logger.js';

const logger = Logger.get('RedisStore');
const KEY_PREFIX = 'helium:security:';
const ENABLED = process.env.HELIUM_REDIS_ENABLED === 'true' && Boolean(process.env.REDIS_URL);

class RedisStore {
  constructor() {
    this._client = null;
    this._enabled = ENABLED;
    this._ready = false;
    this._connectPromise = null;
  }

  async connect() {
    if (!this._enabled || this._ready) return;
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = (async () => {
      try {
        const { createClient } = await import('redis');
        const client = createClient({
          url: process.env.REDIS_URL,
          socket: {
            connectTimeout: 3_000,
            reconnectStrategy: (retries) => retries >= 3 ? false : Math.min(250 * (2 ** retries), 1_000),
          },
        });
        client.on('error', (error) => {
          this._ready = false;
          logger.warn(`Optional Redis rate-limit store error: ${error.message}`);
        });
        client.on('ready', () => { this._ready = true; });
        client.on('end', () => { this._ready = false; });
        await client.connect();
        this._client = client;
        this._ready = true;
        logger.info('Optional distributed Redis rate-limit store connected');
      } catch (error) {
        this._client = null;
        this._ready = false;
        logger.warn(`Optional Redis rate-limit store unavailable; using bounded local fallback (${error.message})`);
      } finally {
        this._connectPromise = null;
      }
    })();
    return this._connectPromise;
  }

  _key(key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 500) return null;
    return `${KEY_PREFIX}${key}`;
  }

  /** Atomic distributed fixed-window counter for security/rate-limit features. */
  async consumeRateLimit(key, windowSeconds = 60) {
    const prefixed = this._key(`ratelimit:${key}`);
    const window = Math.floor(Number(windowSeconds));
    if (!prefixed || !this._enabled || !Number.isFinite(window) || window < 1 || window > 86_400) return null;
    try {
      await this.connect();
      if (!this._ready || !this._client) return null;
      const value = await this._client.eval(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n",
        { keys: [prefixed], arguments: [String(window)] },
      );
      return Number(value);
    } catch (error) {
      logger.warn(`Distributed rate limit unavailable; bounded local limiter will be used (${error.message})`);
      return null;
    }
  }

  async disconnect() {
    const client = this._client;
    this._client = null;
    this._ready = false;
    if (client) {
      try { await client.quit(); } catch { try { client.disconnect(); } catch {} }
    }
  }

  get isAvailable() { return this._enabled && this._ready && Boolean(this._client); }
}

export const redisStore = new RedisStore();
