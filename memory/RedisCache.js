/**
 * @fileoverview Optional Redis cache layer for RAG query results.
 *
 * Sits between the in-memory MemoryCache and the full RAG pipeline.
 * Survives bot restarts — in-memory cache is wiped on restart, Redis is not.
 * Useful on Render where the bot restarts on deploy or memory pressure.
 *
 * COMPLETELY OPTIONAL — if REDIS_URL is not set in env, every method
 * silently no-ops and the bot behaves exactly as before. No errors, no
 * warnings beyond the single startup log. Safe to deploy without Redis.
 *
 * Setup (Render):
 *   1. Add a Redis instance from the Render dashboard
 *   2. Render auto-injects REDIS_URL into the service env
 *   3. Deploy — done.
 *
 * Uses the `redis` package (node-redis v4) which is already a dependency.
 *
 * Key format : lumin:rag:{historyId}:{queryHash}
 * TTL        : REDIS_TTL_SECONDS (default 120s — matches in-memory cache)
 *
 * @module memory/RedisCache
 */

import { Logger } from '../core/Logger.js';
import { MEMORY_CACHE_TTL_MS, EMBEDDING_REDIS_PREFIX } from './config.js';

const logger = Logger.get('RedisCache');

// RAG query results TTL mirrors the in-memory cache (MEMORY_CACHE_TTL_MS = 2 min).
const REDIS_TTL_SECONDS = Math.floor(MEMORY_CACHE_TTL_MS / 1000);
// Separate key prefix from embedding keys so namespaces never collide.
const KEY_PREFIX = 'helium:rag:';

// ============================================================================
// REDIS CLIENT
// ============================================================================

class RedisCache {
  constructor() {
    /** @type {import('redis').RedisClientType|null} */
    this._client  = null;
    this._enabled = false;
    this._ready   = false;
  }

  /**
   * Initialise the Redis connection.
   * Called once at startup from MemorySystem.init().
   * Safe to call multiple times — no-ops after first successful connect.
   *
   * @returns {Promise<void>}
   */
  async connect() {
    if (this._client) return;

    if (process.env.ENABLE_REDIS !== 'true') {
      logger.info('ENABLE_REDIS is false — Redis cache bypassed, running ultra-fast W-TinyLFU memory cache');
      return;
    }

    const url = process.env.REDIS_URL;
    if (!url) {
      logger.info('REDIS_URL not set — Redis cache disabled, using in-memory only');
      return;
    }

    try {
      const { createClient } = await import('redis');

      this._client = createClient({
        url,
        socket: {
          connectTimeout: 5_000,
          reconnectStrategy: (retries) => {
            if (retries >= 5) {
              logger.warn('Redis max reconnect attempts reached — disabling Redis cache');
              this._enabled = false;
              return false; // stop retrying
            }
            return Math.min(retries * 200, 2_000); // exponential backoff, max 2s
          }
        }
      });

      this._client.on('ready', () => {
        this._ready   = true;
        this._enabled = true;
        logger.info('Redis cache connected and ready');
      });

      this._client.on('error', (err) => {
        // Suppress ECONNREFUSED spam — it fires on every reconnect attempt
        if (err.code !== 'ECONNREFUSED') {
          logger.warn(`Redis error: ${err.message}`);
        }
        this._ready = false;
      });

      this._client.on('reconnecting', () => {
        logger.debug('Redis reconnecting…');
      });

      this._client.on('end', () => {
        this._ready = false;
      });

      await this._client.connect();

    } catch (err) {
      logger.warn(`Redis init failed (${err.message}) — falling back to in-memory cache only`);
      this._client  = null;
      this._enabled = false;
    }
  }

  /**
   * Build a namespaced Redis key.
   * @param {string} historyId
   * @param {string} queryHash
   * @returns {string}
   */
  _key(historyId, queryHash) {
    return `${KEY_PREFIX}${historyId}:${queryHash}`;
  }

  /**
   * Retrieve cached RAG results from Redis.
   * Returns null on any failure — caller falls through to full RAG.
   *
   * @param {string} historyId
   * @param {string} queryHash
   * @returns {Promise<object[]|null>}
   */
  async get(historyId, queryHash) {
    if (!this._enabled || !this._ready || !this._client) return null;

    try {
      const raw = await this._client.get(this._key(historyId, queryHash));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Store RAG results in Redis with TTL.
   * Fire-and-forget — never blocks a response.
   *
   * @param {string}   historyId
   * @param {string}   queryHash
   * @param {object[]} results
   */
  set(historyId, queryHash, results) {
    if (!this._enabled || !this._ready || !this._client) return;

    this._client
      .set(this._key(historyId, queryHash), JSON.stringify(results), { EX: REDIS_TTL_SECONDS })
      .catch(() => {});
  }

  /**
   * Invalidate all cached results for a historyId.
   * Uses SCAN to avoid blocking Redis with KEYS on large keyspaces.
   *
   * @param {string} historyId
   * @returns {Promise<void>}
   */
  async invalidate(historyId) {
    if (!this._enabled || !this._ready || !this._client) return;

    try {
      const pattern = `${KEY_PREFIX}${historyId}:*`;
      let   cursor  = 0;

      do {
        const reply = await this._client.scan(cursor, { MATCH: pattern, COUNT: 100 });
        cursor = reply.cursor;
        if (reply.keys.length > 0) {
          await this._client.del(reply.keys);
        }
      } while (cursor !== 0);

    } catch (err) {
      logger.debug(`Redis invalidation failed for ${historyId}: ${err.message}`);
    }
  }

  /**
   * Gracefully disconnect. Called on process exit.
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (this._client) {
      try { await this._client.quit(); } catch { /* ignore */ }
      this._client  = null;
      this._enabled = false;
      this._ready   = false;
    }
  }

  /** Whether Redis is currently connected and usable. */
  get isAvailable() {
    return this._enabled && this._ready;
  }

  /**
   * Raw key-value get — for use outside the historyId/queryHash namespace.
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async rawGet(key) {
    if (!this._enabled || !this._ready || !this._client) return null;
    try {
      return await this._client.get(key);
    } catch { return null; }
  }

  /**
   * Raw key-value set with explicit TTL.
   * @param {string} key
   * @param {string} value
   * @param {number} ttlSeconds
   * @returns {Promise<void>}
   */
  async rawSet(key, value, ttlSeconds) {
    if (!this._enabled || !this._ready || !this._client) return;
    try {
      await this._client.set(key, value, { EX: ttlSeconds });
    } catch { /* non-fatal */ }
  }
}

export const redisCache = new RedisCache();
