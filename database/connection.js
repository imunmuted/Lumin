/**
 * @fileoverview MongoDB connection management, lazy collection cache, and
 *               shared constants used by all repository modules.
 * @module database/connection
 */

import { MongoClient } from 'mongodb';
import { Logger }      from '../core/Logger.js';
import {
  DB_CONNECTION_CONFIG as CONNECTION_CONFIG,
  DB_RETRY_CONFIG      as RETRY_CONFIG
} from './config.js';

// The active data layer deliberately exposes no vector-memory search configuration.
export { CONNECTION_CONFIG, RETRY_CONFIG };

const logger = Logger.get('Database');

// ============================================================================
// SECURITY HELPERS
// ============================================================================

/**
 * Strip any top-level keys beginning with '$' from a plain object before it
 * reaches a MongoDB $set or insertOne call. Prevents NoSQL operator injection
 * if a caller accidentally spreads user-controlled data into a write operation.
 * Does NOT recurse into nested objects — shallow sanitisation is sufficient
 * because MongoDB only evaluates top-level operator keys.
 *
 * @param {Object} obj
 * @returns {Object} Safe copy with operator keys removed
 */
export function sanitizeDoc(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj ?? {};
  const safe = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith('$')) safe[k] = v;
  }
  return safe;
}

/**
 * Validate that a field name is safe to use as a dynamic MongoDB key.
 * Rejects anything that starts with '$' or contains a dot (path injection).
 *
 * @param {string} fieldName
 * @returns {boolean}
 */
export function isSafeFieldName(fieldName) {
  return typeof fieldName === 'string' && !fieldName.startsWith('$') && !fieldName.includes('.');
}

/** Canonical collection name registry. All repository modules import from here. */
export const COLLECTIONS = Object.freeze({
  USER_SETTINGS:        'userSettings',
  SERVER_SETTINGS:      'serverSettings',
  CHAT_HISTORIES:       'chatHistories',
  CUSTOM_INSTRUCTIONS:  'customInstructions',
  BLACKLISTED_USERS:    'blacklistedUsers',
  CHANNEL_SETTINGS:     'channelSettings',
  MEMORY_ENTRIES:       'memoryEntries',
  IMAGE_USAGE:          'imageUsage',
  BIRTHDAYS:            'birthdays',
  REMINDERS:            'reminders',
  DAILY_QUOTES:         'dailyQuotes',
  ROULETTE:             'roulette',
  COMPLIMENTS:          'compliments',
  COMPLIMENT_OPT_OUT:   'complimentOptOut',
  USER_TIMEZONES:       'userTimezones',
  SERVER_DIGESTS:       'serverDigests',
  ACTIVE_USERS:         'activeUsersInChannels',
  USER_RESPONSE_PREF:   'userResponsePreference',
  REALIVE:              'realive',
  SUMMARY_USAGE:        'summaryUsage',
  QUOTE_USAGE:          'quoteUsage',
  USER_FACTS:           'userFacts',
  SERVER_FACTS:         'serverFacts',
  WEEKLY_SUMMARIES:     'weeklySummaries',
  SESSION_SUMMARIES:    'sessionSummaries',
  DAILY_MSG_USAGE:      'dailyMsgUsage',
  INDEXED_COUNTS:       'indexedCounts'
});

// ============================================================================
// MODULE STATE
// ============================================================================

/** @type {MongoClient|null} */
let client = null;

/** @type {import('mongodb').Db|null} */
let db = null;

/** Lazy-loaded collection handle cache. Invalidated on close. */
const collectionCache = new Map();

/**
 * Tracks whether background index creation has been scheduled for the current
 * connection. Reset in closeDB so a reconnect re-schedules index creation.
 */
export let indexesCreated = false;
export function setIndexesCreated(v) { indexesCreated = v; }

// ============================================================================
// CONNECTION MANAGEMENT
// ============================================================================

/**
 * Connect to MongoDB. Returns the existing connection if healthy.
 * Pings the server before returning a cached handle — catches stale connections
 * after network drops without waiting for the next operation to fail.
 * @returns {Promise<import('mongodb').Db>}
 * @throws {Error} If all retry attempts fail
 */
export async function connectDB() {
  // Return cached connection only if it is still alive
  if (db) {
    try {
      await client.db().admin().ping();
      return db;
    } catch {
      logger.warn('Cached DB connection appears stale — reconnecting…');
      client = null;
      db     = null;
      collectionCache.clear();
      indexesCreated = false;
    }
  }

  const configuredUri = process.env.MONGODB_URI;
  const uri = configuredUri || (process.env.NODE_ENV === 'production' ? '' : 'mongodb://localhost:27017/gemini-discord-bot');
  if (!uri) throw new Error('MONGODB_URI is required in production.');
  let lastError;

  for (let attempt = 1; attempt <= RETRY_CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      logger.info(`Attempting MongoDB connection (${attempt}/${RETRY_CONFIG.MAX_ATTEMPTS})…`);

      client = new MongoClient(uri, {
        maxPoolSize:              CONNECTION_CONFIG.MAX_POOL_SIZE,
        minPoolSize:              CONNECTION_CONFIG.MIN_POOL_SIZE,
        serverSelectionTimeoutMS: CONNECTION_CONFIG.SERVER_SELECTION_TIMEOUT_MS,
        socketTimeoutMS:          CONNECTION_CONFIG.SOCKET_TIMEOUT_MS,
        maxIdleTimeMS:            CONNECTION_CONFIG.MAX_IDLE_TIME_MS,
        retryWrites:              CONNECTION_CONFIG.RETRY_WRITES,
        w:                        CONNECTION_CONFIG.W
      });

      await client.connect();
      await client.db().admin().ping();

      db = client.db();
      logger.info('Connected to MongoDB successfully');

      // Import lazily to avoid circular dependency at module load time
      const { createIndexes } = await import('./indexManager.js');
      createIndexes().catch(err =>
        logger.warn(`Background index creation failed: ${err.message}`)
      );

      return db;

    } catch (error) {
      lastError = error;
      logger.error(`Connection attempt ${attempt} failed: ${error.message}`);

      if (attempt < RETRY_CONFIG.MAX_ATTEMPTS) {
        const delay = Math.min(
          RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt - 1),
          RETRY_CONFIG.MAX_DELAY_MS
        );
        logger.info(`Retrying in ${delay}ms…`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(`MongoDB connection failed after ${RETRY_CONFIG.MAX_ATTEMPTS} attempts: ${lastError.message}`);
}

/**
 * Close the MongoDB connection and reset all module state.
 * @returns {Promise<void>}
 */
export async function closeDB() {
  if (!client) {
    logger.info('No active database connection to close');
    return;
  }

  try {
    await client.close();
    client         = null;
    db             = null;
    indexesCreated = false; // reset so a subsequent connectDB re-registers indexes
    collectionCache.clear();
    logger.info('MongoDB connection closed');
  } catch (error) {
    logger.error('Error closing MongoDB connection', error);
    throw error;
  }
}

/**
 * Returns the raw Db instance. Throws if not connected.
 * @returns {import('mongodb').Db}
 */
export function getDB() {
  if (!db) throw new Error('Database not connected. Call connectDB() first.');
  return db;
}

// ============================================================================
// LAZY COLLECTION ACCESSOR
// ============================================================================

/**
 * Returns a cached Collection handle, creating it on first access.
 * @param {string} collectionName
 * @returns {import('mongodb').Collection}
 */
export function getCollection(collectionName) {
  if (!db) throw new Error('Database not connected');
  if (!collectionCache.has(collectionName)) {
    collectionCache.set(collectionName, db.collection(collectionName));
  }
  return collectionCache.get(collectionName);
}
