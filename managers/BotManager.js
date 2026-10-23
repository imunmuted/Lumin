/**
 * @fileoverview Bot Manager — thin orchestrator that wires together all sub-managers
 * and provides the `genAI` proxy, Discord `client`, `TEMP_DIR`, and `initialize()`.
 *
 * This file intentionally stays thin (< 200 lines of logic).  All heavy lifting
 * lives in the specialist managers it imports.
 *
 * What lives here:
 *  - Discord `client` creation
 *  - `TEMP_DIR` constant
 *  - `genAI` Proxy — wraps every Gemini call through `withRetryPerModel`
 *  - `createPartFromUri()` — convenience helper
 *  - `initialize()` — startup sequence (DB → state → schedule → log)
 *  - `gracefulShutdown()` — SIGINT / SIGTERM handler
 *  - Re-export barrel — everything other modules import from `botManager.js`
 *    still works without any import changes
 *
 * @module managers/BotManager
 */

import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Partials, Options } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

import * as db from '../database.js';
import { Logger } from '../core/Logger.js';
import { memorySystem } from '../memory/MemorySystem.js';

import {
  withRetryPerModel,
  withRetry,
  getCurrentClient,
  getApiKeyStats,
  getApiKeyCount,
  switchToNextKey,
  switchToNextKeyOrModel,
  rotateToNextKey,
  dumpKeyStats,
  loadKeyStats,
} from './ApiKeyManager.js';

import {
  chatHistoryLock,
  getHistoryLock,
  requestQueues,
  checkImageRateLimit,
  incrementImageUsage,
  checkSummaryRateLimit,
  incrementSummaryUsage,
  getDailyMessageStats,
  checkQueueDepth,
  getRamUsageMB
} from './QueueManager.js';

import {
  state,
  saveStateToFile,
  requestStateSave,
  loadStateFromDB,
  getHistory,
  updateChatHistory,
  getUserResponsePreference,
  initializeBlacklistForGuild,
  scheduleDailyReset,
  runMigrations,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_USER_SETTINGS,
  getDefaultServerSettings,
  getDefaultUserSettings,
  getSettingDefaults,
  saveSettingDefaultsToDB,
} from './StateManager.js';
import { RESOURCE_CONFIG, BOT_CONFIG, POLL_CONFIG, MIGRATION_CONFIG } from './config.js';

const logger = Logger.get('BotManager');

// ============================================================================
// FILE SYSTEM
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/**
 * Temporary directory for all file operations (uploads, conversions, responses).
 * Resolved relative to the project root (one level above `managers/`).
 * @type {string}
 */
export const TEMP_DIR = process.env.TEMP_DIR
  ? path.resolve(process.env.TEMP_DIR)
  : path.join(__dirname, '..', 'temp');

// ============================================================================
// DISCORD CLIENT
// ============================================================================

/** Discord bot token. @type {string|undefined} */
export const token = process.env.DISCORD_BOT_TOKEN;

/**
 * Discord.js client with the minimal intents Lumin needs.
 * @type {import('discord.js').Client}
 */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,   // needed for voice channel member lists
    GatewayIntentBits.GuildPresences,     // PRIVILEGED — enable in Discord Dev Portal first
  ],
  partials: [Partials.Channel],

  // ── Heap reduction: limit discord.js internal caches ──────────────────────
  // By default discord.js caches 200 messages/channel, all guild members,
  // all presences, all reactions, etc.  In servers with thousands of members
  // this becomes the #1 source of heap growth.
  //
  // Safe to customise: MessageManager, GuildMemberManager, UserManager,
  //                    PresenceManager, ReactionManager, StageInstanceManager,
  //                    ThreadManager.
  // NOT safe to customise: GuildManager, ChannelManager, GuildChannelManager,
  //                         RoleManager, PermissionOverwriteManager
  //                         (discord.js will break if these are limited).
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,

    // Messages — default 200/channel; 50 is plenty for a chat bot
    MessageManager: 50,

    // Members — default: all; cap per-guild to avoid OOM in large servers.
    // keepOverLimit ensures the bot's own member entry is never evicted.
    GuildMemberManager: {
      maxSize: 100,
      keepOverLimit: member => member.id === member.client.user?.id
    },

    // Presences are never used by Lumin — zero them out entirely
    PresenceManager: 0,

    // Reactions — small cache for recent reactions; 0 would prevent react operations
    ReactionManager: 10,

    // Stage instances not used — zero out
    StageInstanceManager: 0,
  }),

  // ── Sweepers: periodically evict stale cached objects ─────────────────────
  sweepers: {
    messages: {
      interval: 3600,    // run sweep every hour (seconds)
      lifetime: 1800     // evict messages older than 30 min
    },
    users: {
      interval: 3600,
      filter: () => user => !user.bot
    },
    guildMembers: {
      interval: 3600,
      filter: () => member => member.id !== member.client.user?.id
    }
  }
});

// ============================================================================
// GEMINI AI PROXY
// ============================================================================

/**
 * Proxied Gemini AI client.
 *
 * Every call to `genAI.models.generateContent(…)` etc. is automatically routed
 * through `withRetryPerModel` in ApiKeyManager, which handles:
 *  - Per-model, per-key rate-limit tracking
 *  - Intelligent model fallback (same key, different model)
 *  - Key rotation when all models on the current key are exhausted
 *  - Exponential back-off with jitter
 *
 * Consumers should use this exactly like the raw `GoogleGenAI` client.
 *
 * @type {Proxy}
 */

/**
 * Strip Gemini-3-only config fields when the model rotates to a non-Gemini-3 model.
 * Called inside the proxy callback every time ApiKeyManager picks a model.
 * Without this, toolConfig.includeServerSideToolInvocations and built-in tools
 * (urlContext, codeExecution) stay in the request after a fallback, causing
 * 400 INVALID_ARGUMENT on a fallback model with incompatible tools — retried repeatedly and burned quota.
 *
 * @param {object} request - Mutated in place.
 * @param {string} modelName - The model ApiKeyManager is about to call.
 */
export function sanitizeRequestForModel(request, modelName) {
  const isGemini3 = /gemini-3/i.test(modelName);
  const isGemma   = /gemma/i.test(modelName);

  if (!request.config) return;

  // Remove Gemini-3-only toolConfig flag for all other models
  if (!isGemini3 || isGemma) {
    delete request.config.toolConfig;
  }

  // Strip built-in server-side tools for non-Gemini-3
  // Gemma keeps googleSearch, strips urlContext + codeExecution
  if (request.config.tools?.length) {
    if (isGemma) {
      request.config.tools = request.config.tools.filter(
        t => t.googleSearch || t.functionDeclarations
      );
    } else if (!isGemini3) {
      request.config.tools = request.config.tools.filter(t => t.functionDeclarations);
    }
  }
}

export const genAI = new Proxy({}, {
  get(_target, prop) {
    // ── models ───────────────────────────────────────────────────────────────
    if (prop === 'models') {
      return {
        generateContent: (request) =>
          withRetryPerModel(
            (modelName) => {
              request.model = modelName;
              sanitizeRequestForModel(request, modelName);
              return getCurrentClient().models.generateContent(request);
            },
            request.model
          ),

        generateContentStream: (request) =>
          withRetryPerModel(
            (modelName) => {
              request.model = modelName;
              sanitizeRequestForModel(request, modelName);
              return getCurrentClient().models.generateContentStream(request);
            },
            request.model
          ),

        // embedContent doesn't need per-model rotation — just basic retry.
        embedContent: (request) =>
          withRetry(() => getCurrentClient().models.embedContent(request))
      };
    }

    // ── chats ─────────────────────────────────────────────────────────────────
    if (prop === 'chats') {
      return {
        create: (chatConfig) => {
          const chat = getCurrentClient().chats.create(chatConfig);
          return {
            sendMessage: (message) => withRetry(() => chat.sendMessage(message))
          };
        }
      };
    }

    // ── files ─────────────────────────────────────────────────────────────────
    if (prop === 'files') {
      return {
        upload: (options) => withRetry(() => getCurrentClient().files.upload(options)),
        get:    (options) => withRetry(() => getCurrentClient().files.get(options))
      };
    }

    // Fall through for any other property.
    const value = getCurrentClient()[prop];
    return typeof value === 'function' ? value.bind(getCurrentClient()) : value;
  }
});

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build a Gemini file-data part from an uploaded file URI.
 *
 * @param {string} fileUri  - URI returned by `genAI.files.upload()`.
 * @param {string} mimeType - MIME type of the file.
 * @returns {{ fileData: { fileUri: string, mimeType: string } }}
 */
export function createPartFromUri(fileUri, mimeType) {
  return { fileData: { fileUri, mimeType } };
}

// ============================================================================
// RESOURCE CONFIGURATION (intervals — kept here with initialize())
// ============================================================================

// RESOURCE_CONFIG imported from ./config.js

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize Bot Manager.
 *
 * Sequence:
 *  1. Validate environment
 *  2. Connect to database
 *  3. Load state from DB
 *  4. Trigger migrations (background, non-blocking)
 *  5. Schedule daily reset
 *  6. Schedule periodic state saves
 *  7. Schedule API key statistics logging
 *  8. Log startup summary
 *
 * @returns {Promise<void>}
 * @throws {Error} On critical failures (missing token, DB connection error, etc.)
 */
export async function initialize() {
  logger.info('Initializing Bot Manager…');

  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN not found in environment variables');
  }

  // 1. Database
  await db.connectDB();
  logger.info('Database connected');

  // 2. State
  await loadStateFromDB(TEMP_DIR);
  logger.info('State loaded');

  // 3. Minimal history facade (no vector indexing; does not connect to Redis)
  await memorySystem.init();
  logger.info('Memory system initialized');

  // 3. Migrations (background — never block startup)
  if (MIGRATION_CONFIG.ENABLE_MIGRATION) {
    runMigrations().catch(err =>
      logger.warn(`Migration failed (non-critical): ${err.message}`)
    );
  }

  // 4. Daily reset
  scheduleDailyReset();
  logger.info('Daily reset scheduled');

  // 5. Periodic state save
  setInterval(async () => {
    try {
      await saveStateToFile();
      logger.info('Periodic state save completed');
    } catch (error) {
      logger.error('Periodic state save failed', error);
    }
  }, RESOURCE_CONFIG.STATE_SAVE_INTERVAL);

  // 6. Periodic API key statistics
  setInterval(() => {
    const stats = getApiKeyStats();
    const table = stats.keys
      .map(k => `Key${k.keyNumber}[${k.status} req:${k.totalRequests} ok:${k.successfulRequests} err:${k.errors}${k.isCurrent ? ' *' : ''}]`)
      .join(' | ');
    logger.info(`API Key Stats: ${table}`);
  }, RESOURCE_CONFIG.STATS_LOG_INTERVAL);

  // 7. Compact startup log
  const startupStats = getApiKeyStats();
  logger.info(
    `Startup: ${startupStats.totalKeys} keys | Current: Key ${startupStats.currentKey} | ` +
    startupStats.keys
      .map(k => `Key${k.keyNumber}[${k.status} req:${k.totalRequests} err:${k.errors}${k.isCurrent ? ' *' : ''}]`)
      .join(' ')
  );

  logger.info('Bot Manager initialized successfully ✅');
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * Perform graceful shutdown: save state, close DB, log final stats, exit.
 * @param {string} signal - Signal name (e.g. 'SIGINT', 'SIGTERM').
 */
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal} — performing graceful shutdown…`);

  try {
    logger.info('Saving final state…');
    await saveStateToFile();
    logger.info('State saved');

    logger.info('Closing database connection…');
    await db.closeDB();
    logger.info('Database connection closed');

    logger.info('Closing optional distributed rate-limit store…');
    const { redisStore } = await import('../infra/RedisStore.js');
    await redisStore.disconnect();
    logger.info('Optional distributed rate-limit store disconnected');

    const shutdownStats = getApiKeyStats();
    logger.info(
      `Shutdown stats: ${shutdownStats.totalKeys} keys | ` +
      shutdownStats.keys
        .map(k => `Key${k.keyNumber}[req:${k.totalRequests} ok:${k.successfulRequests} err:${k.errors}]`)
        .join(' ')
    );

    logger.info('Graceful shutdown completed ✅');
    process.exit(0);

  } catch (error) {
    logger.error('Error during graceful shutdown', error);
    process.exit(1);
  }
}

// SIGINT/SIGTERM are registered only in index.js, which also destroys the Discord client.

// ============================================================================
// RE-EXPORT BARREL
// ============================================================================
// Everything that other modules currently import from `botManager.js` is
// re-exported here so zero import paths need to change.

export {
  // ApiKeyManager
  getApiKeyStats,
  switchToNextKey,
  switchToNextKeyOrModel,
  rotateToNextKey,
  dumpKeyStats,
  loadKeyStats,

  // QueueManager
  chatHistoryLock,
  getHistoryLock,
  requestQueues,
  checkImageRateLimit,
  incrementImageUsage,
  checkSummaryRateLimit,
  incrementSummaryUsage,
  getDailyMessageStats,

  // StateManager
  state,
  saveStateToFile,
  requestStateSave,
  getHistory,
  updateChatHistory,
  getUserResponsePreference,
  initializeBlacklistForGuild,
  BOT_CONFIG,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_USER_SETTINGS,
  getDefaultServerSettings,
  getDefaultUserSettings,
  getSettingDefaults,
  saveSettingDefaultsToDB,
  POLL_CONFIG,
  MIGRATION_CONFIG
};

// Default export mirrors the original botManager.js shape.
export default {
  client,
  token,
  genAI,
  state,
  initialize,
  saveStateToFile,
  getHistory,
  updateChatHistory,
  getApiKeyStats,
  checkImageRateLimit,
  incrementImageUsage,
  checkSummaryRateLimit,
  incrementSummaryUsage,
  switchToNextKeyOrModel,
  switchToNextKey,
  createPartFromUri,
  getUserResponsePreference,
  initializeBlacklistForGuild,
  chatHistoryLock,
  requestQueues,
  TEMP_DIR,
  BOT_CONFIG,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_USER_SETTINGS,
  getDefaultServerSettings,
  getDefaultUserSettings,
  getSettingDefaults,
  saveSettingDefaultsToDB,
  POLL_CONFIG,
  MIGRATION_CONFIG
};
