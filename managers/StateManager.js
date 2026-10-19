/**
 * @fileoverview State Manager — BotState class, database persistence, chat-history
 * management, guild initialisation, and the daily-reset scheduler.
 *
 * Responsibilities (and ONLY these):
 *  - `BotState` class and its singleton `state`
 *  - `saveStateToFile()` — debounced parallel save to DB
 *  - `loadStateFromDB()` — parallel load on startup
 *  - `getHistory()` / `updateChatHistory()` — API-ready history helpers
 *  - `getUserResponsePreference()` / `initializeBlacklistForGuild()` — quick lookups
 *  - `scheduleDailyReset()` — midnight UTC reset of usage counters
 *  - `runMigrations()` — optional one-shot settings migration
 *
 * @module managers/StateManager
 */

import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

import * as db from '../database.js';
import { Logger } from '../core/Logger.js';
import { formatDuration } from '../modules/shared/messageFormatter.js';
import {
  chatHistoryLock,
  setImageUsageStore,
  setSummaryUsageStore,
  resetImageUsage,
  resetSummaryUsage,
  resetDailyMessageUsage
} from './QueueManager.js';
import {
  DEFAULT_MODEL, BOT_CONFIG, STATE_CONFIG,
  MIGRATION_CONFIG, POLL_CONFIG, PERSONALIZATION_DEFAULT
} from './config.js';

const logger = Logger.get('StateManager');

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ============================================================================
// CONFIGURATION
// ============================================================================

// BOT_CONFIG, STATE_CONFIG, MIGRATION_CONFIG, POLL_CONFIG imported from ./config.js

/** Default settings applied to new servers. @readonly */
export const DEFAULT_SERVER_SETTINGS = Object.freeze({
  selectedModel:        DEFAULT_MODEL,
  responseFormat:       'Normal',
  showActionButtons:    false,
  continuousReply:      false,
  customPersonality:    null,
  embedColor:           '#5B7C99',
  overrideUserSettings: true,
  serverChatHistory:    false,
  allowedChannels:      [],
  gemmaEnabled:         false
});

/** Default settings applied to new users. @readonly */
export const DEFAULT_USER_SETTINGS = Object.freeze({
  selectedModel:       DEFAULT_MODEL,
  responseFormat:      'Normal',
  showActionButtons:   false,
  continuousReply:     true,
  customPersonality:   null,
  embedColor:          '#5B7C99',
  gemmaEnabled:        false,
  personalization:     PERSONALIZATION_DEFAULT,
  crossContextEnabled: PERSONALIZATION_DEFAULT
});

// POLL_CONFIG, MIGRATION_CONFIG, STATE_CONFIG imported from ./config.js — do not redefine here.

// ============================================================================
// BOT STATE
// ============================================================================

/**
 * Central state object.  All fields have typed getters and setters.
 * Intentionally NOT exported raw — always access via the `state` singleton.
 */
class BotState {
  constructor() {
    this._chatHistories          = {};
    this._activeUsersInChannels  = {};
    this._customInstructions     = {};
    this._serverSettings         = {};
    this._userSettings           = {};
    this._userResponsePreference = {};
    this._alwaysRespondChannels  = {};
    this._channelWideChatHistory = {};
    this._blacklistedUsers       = {};
    this._continuousReplyChannels = {};
    this._imageUsage             = {};
    this._birthdays              = {};
    this._reminders              = {};
    this._dailyQuotes            = {};
    this._roulette               = {};
    this._complimentCounts       = {};
    this._complimentOptOut       = {};
    this._userTimezones          = {};
    this._serverDigests          = {};
    this._quoteUsage             = {};
    this._starterUsage           = {};
    this._complimentUsage        = {};
    this._userDigests            = {};
    this._realive                = {};
    this._summaryUsage           = {};
  }

  get chatHistories()           { return this._chatHistories; }
  set chatHistories(v)          { this._chatHistories = v; }

  get activeUsersInChannels()   { return this._activeUsersInChannels; }
  set activeUsersInChannels(v)  { this._activeUsersInChannels = v; }

  get customInstructions()      { return this._customInstructions; }
  set customInstructions(v)     { this._customInstructions = v; }

  get serverSettings()          { return this._serverSettings; }
  set serverSettings(v)         { this._serverSettings = v; }

  get userSettings()            { return this._userSettings; }
  set userSettings(v)           { this._userSettings = v; }

  get userResponsePreference()  { return this._userResponsePreference; }
  set userResponsePreference(v) { this._userResponsePreference = v; }

  get alwaysRespondChannels()   { return this._alwaysRespondChannels; }
  set alwaysRespondChannels(v)  { this._alwaysRespondChannels = v; }

  get channelWideChatHistory()  { return this._channelWideChatHistory; }
  set channelWideChatHistory(v) { this._channelWideChatHistory = v; }

  get blacklistedUsers()        { return this._blacklistedUsers; }
  set blacklistedUsers(v)       { this._blacklistedUsers = v; }

  get continuousReplyChannels() { return this._continuousReplyChannels; }
  set continuousReplyChannels(v){ this._continuousReplyChannels = v; }

  get imageUsage()              { return this._imageUsage; }
  set imageUsage(v)             { this._imageUsage = v; setImageUsageStore(v); }

  get birthdays()               { return this._birthdays; }
  set birthdays(v)              { this._birthdays = v; }

  get reminders()               { return this._reminders; }
  set reminders(v)              { this._reminders = v; }

  get dailyQuotes()             { return this._dailyQuotes; }
  set dailyQuotes(v)            { this._dailyQuotes = v; }

  get roulette()                { return this._roulette; }
  set roulette(v)               { this._roulette = v; }

  get complimentCounts()        { return this._complimentCounts; }
  set complimentCounts(v)       { this._complimentCounts = v; }

  get complimentOptOut()        { return this._complimentOptOut; }
  set complimentOptOut(v)       { this._complimentOptOut = v; }

  get userTimezones()           { return this._userTimezones; }
  set userTimezones(v)          { this._userTimezones = v; }

  get serverDigests()           { return this._serverDigests; }
  set serverDigests(v)          { this._serverDigests = v; }

  get quoteUsage()              { return this._quoteUsage; }
  set quoteUsage(v)             { this._quoteUsage = v; }

  get starterUsage()            { return this._starterUsage; }
  set starterUsage(v)           { this._starterUsage = v; }

  get complimentUsage()         { return this._complimentUsage; }
  set complimentUsage(v)        { this._complimentUsage = v; }

  get userDigests()             { return this._userDigests; }
  set userDigests(v)            { this._userDigests = v; }

  get realive()                 { return this._realive; }
  set realive(v)                { this._realive = v; }

  get summaryUsage()            { return this._summaryUsage; }
  set summaryUsage(v)           { this._summaryUsage = v; setSummaryUsageStore(v); }
}

/**
 * Global bot-state singleton.
 * @type {BotState}
 */
export const state = new BotState();

// ============================================================================
// STATE PERSISTENCE
// ============================================================================

let isSaving    = false;
let savePending = false;
/** M-4 fix: time-based debounce — coalesces burst saves into one disk write. */
let _saveDebounceTimer = null;

/**
 * Request a state save, coalescing burst calls into a single write.
 * Callers that previously awaited saveStateToFile() for correctness can still
 * call this, but routine "settings changed" triggers should prefer the debounced
 * version which queues a save 500ms later.
 * @returns {void}
 */
export function requestStateSave() {
  if (_saveDebounceTimer) return; // already queued
  _saveDebounceTimer = setTimeout(() => {
    _saveDebounceTimer = null;
    saveStateToFile().catch(err => logger.error('Debounced save failed', err));
  }, 500);
}

/**
 * Persist all bot state to the database.
 * Implements double-buffered debouncing: if a save is already in flight,
 * the next call sets a flag and re-runs once the current save completes.
 *
 * All individual collection saves run in parallel via `Promise.all` for speed.
 *
 * @returns {Promise<void>}
 */
export async function saveStateToFile() {
  if (isSaving) {
    savePending = true;
    return;
  }

  isSaving = true;

  try {
    const saves = [];

    const push = (promise) => saves.push(promise);

    // User settings
    for (const [userId, settings] of Object.entries(state.userSettings ?? {})) {
      push(db.saveUserSettings(userId, settings).catch(e =>
        logger.error(`Failed to save user settings for ${userId}`, e)));
    }

    // Server settings
    for (const [guildId, settings] of Object.entries(state.serverSettings ?? {})) {
      push(db.saveServerSettings(guildId, settings).catch(e =>
        logger.error(`Failed to save server settings for ${guildId}`, e)));
    }

    // Chat histories
    for (const [id, history] of Object.entries(state.chatHistories ?? {})) {
      push(db.saveChatHistory(id, history).catch(e =>
        logger.error(`Failed to save chat history for ${id}`, e)));
    }

    // Custom instructions
    for (const [id, instructions] of Object.entries(state.customInstructions ?? {})) {
      push(db.saveCustomInstructions(id, instructions).catch(e =>
        logger.error(`Failed to save custom instructions for ${id}`, e)));
    }

    // Blacklisted users
    for (const [guildId, users] of Object.entries(state.blacklistedUsers ?? {})) {
      push(db.saveBlacklistedUsers(guildId, users).catch(e =>
        logger.error(`Failed to save blacklist for ${guildId}`, e)));
    }

    // Channel settings
    for (const [channelId, value] of Object.entries(state.alwaysRespondChannels ?? {})) {
      push(db.saveChannelSetting(channelId, 'alwaysRespond', value).catch(e =>
        logger.error(`Failed to save alwaysRespond for ${channelId}`, e)));
    }
    for (const [channelId, value] of Object.entries(state.channelWideChatHistory ?? {})) {
      push(db.saveChannelSetting(channelId, 'wideChatHistory', value).catch(e =>
        logger.error(`Failed to save wideChatHistory for ${channelId}`, e)));
    }
    for (const [channelId, value] of Object.entries(state.continuousReplyChannels ?? {})) {
      push(db.saveChannelSetting(channelId, 'continuousReply', value).catch(e =>
        logger.error(`Failed to save continuousReply for ${channelId}`, e)));
    }

    // User response preferences
    for (const [userId, pref] of Object.entries(state.userResponsePreference ?? {})) {
      push(db.saveUserResponsePreference(userId, pref).catch(e =>
        logger.error(`Failed to save response preference for ${userId}`, e)));
    }

    // Image usage
    for (const [userId, usage] of Object.entries(state.imageUsage ?? {})) {
      push(db.saveImageUsage(userId, usage).catch(e =>
        logger.error(`Failed to save image usage for ${userId}`, e)));
    }

    // Birthdays
    for (const [userId, data] of Object.entries(state.birthdays ?? {})) {
      push(db.saveBirthday(userId, data).catch(e =>
        logger.error(`Failed to save birthday for ${userId}`, e)));
    }

    // Roulette configs
    for (const [channelId, cfg] of Object.entries(state.roulette ?? {})) {
      push(db.saveRouletteConfig(channelId, cfg).catch(e =>
        logger.error(`Failed to save roulette config for ${channelId}`, e)));
    }

    // Daily quotes
    for (const [userId, cfg] of Object.entries(state.dailyQuotes ?? {})) {
      push(db.saveDailyQuote(userId, cfg).catch(e =>
        logger.error(`Failed to save daily quote for ${userId}`, e)));
    }

    // Compliment counts
    for (const [userId, count] of Object.entries(state.complimentCounts ?? {})) {
      push(db.saveComplimentCount(userId, count).catch(e =>
        logger.error(`Failed to save compliment count for ${userId}`, e)));
    }

    // User timezones
    for (const [userId, tz] of Object.entries(state.userTimezones ?? {})) {
      push(db.saveUserTimezone(userId, tz).catch(e =>
        logger.error(`Failed to save timezone for ${userId}`, e)));
    }

    // Server digests
    for (const [guildId, digest] of Object.entries(state.serverDigests ?? {})) {
      push(db.saveServerDigest(guildId, digest).catch(e =>
        logger.error(`Failed to save server digest for ${guildId}`, e)));
    }

    // Quote usage
    for (const [userId, usage] of Object.entries(state.quoteUsage ?? {})) {
      push(db.saveQuoteUsage(userId, usage).catch(e =>
        logger.error(`Failed to save quote usage for ${userId}`, e)));
    }

    // Realive configs
    for (const [guildId, cfg] of Object.entries(state.realive ?? {})) {
      push(db.saveRealiveConfig(guildId, cfg).catch(e =>
        logger.error(`Failed to save realive config for ${guildId}`, e)));
    }

    // Summary usage
    for (const [userId, usage] of Object.entries(state.summaryUsage ?? {})) {
      push(db.saveSummaryUsage(userId, usage).catch(e =>
        logger.error(`Failed to save summary usage for ${userId}`, e)));
    }

    // Active users in channels (single document)
    saves.push(
      db.saveActiveUsersInChannels(state.activeUsersInChannels).catch(e =>
        logger.error('Failed to save active users', e))
    );

    await Promise.all(saves);

  } catch (error) {
    logger.error('Critical error during state save', error);
  } finally {
    isSaving = false;

    if (savePending) {
      savePending = false;
      // Use setImmediate to avoid stack overflow on rapid successive saves.
      setImmediate(() => saveStateToFile());
    }
  }
}

/**
 * Load all bot state from the database in parallel.
 * Also ensures the temp directory exists.
 *
 * @param {string} tempDir - Absolute path of the temp directory to create.
 * @returns {Promise<void>}
 * @throws {Error} On critical database failure.
 */
export async function loadStateFromDB(tempDir) {
  try {
    await fs.mkdir(tempDir, { recursive: true });

    // L-9 fix: DON'T load all chat histories at startup.
    // They are loaded lazily on first message (see getHistory / updateChatHistory).
    // This makes startup O(servers) instead of O(all-time users).
    const [
      userSettings,
      serverSettings,
      customInstructions,
      blacklistedUsers,
      userResponsePreference,
      activeUsersInChannels,
      imageUsage,
      birthdays,
      reminders,
      dailyQuotes,
      roulette,
      complimentCounts,
      complimentOptOut,
      userTimezones,
      serverDigests,
      quoteUsage,
      realive,
      summaryUsage
    ] = await Promise.all([
      db.getAllUserSettings(),
      db.getAllServerSettings(),
      db.getAllCustomInstructions(),
      db.getAllBlacklistedUsers(),
      db.getAllUserResponsePreferences(),
      db.getActiveUsersInChannels(),
      db.getAllImageUsages(),
      db.getAllBirthdays(),
      db.getAllReminders(),
      db.getAllDailyQuotes(),
      db.getAllRouletteConfigs(),
      db.getAllComplimentCounts(),
      db.getAllComplimentOptOuts(),
      db.getAllUserTimezones(),
      db.getAllServerDigests(),
      db.getAllQuoteUsages(),
      db.getAllRealiveConfigs(),
      db.getAllSummaryUsages()
    ]);

    // L-9: start with empty in-memory histories; lazy-loaded on first access
    state.chatHistories          = {};
    state.userSettings           = userSettings           ?? {};
    state.serverSettings         = serverSettings         ?? {};
    state.customInstructions     = customInstructions     ?? {};
    state.blacklistedUsers       = blacklistedUsers       ?? {};
    state.userResponsePreference = userResponsePreference ?? {};
    state.activeUsersInChannels  = activeUsersInChannels  ?? {};
    state.imageUsage             = imageUsage             ?? {};
    state.birthdays              = birthdays              ?? {};
    state.reminders              = reminders              ?? {};
    state.dailyQuotes            = dailyQuotes            ?? {};
    state.roulette               = roulette               ?? {};
    state.complimentCounts       = complimentCounts       ?? {};
    state.complimentOptOut       = complimentOptOut       ?? {};
    state.userTimezones          = userTimezones          ?? {};
    state.serverDigests          = serverDigests          ?? {};
    state.quoteUsage             = quoteUsage             ?? {};
    state.realive                = realive                ?? {};
    state.summaryUsage           = summaryUsage           ?? {};

    // Channel settings are stored as separate keys.
    state.alwaysRespondChannels  = (await db.getAllChannelSettings('alwaysRespond'))  ?? {};
    state.channelWideChatHistory = (await db.getAllChannelSettings('wideChatHistory')) ?? {};
    state.continuousReplyChannels = (await db.getAllChannelSettings('continuousReply')) ?? {};

    logger.info('Bot state loaded successfully from database');

  } catch (error) {
    logger.error('Critical error loading state from database', error);
    throw error;
  }
}

// ============================================================================
// HISTORY MANAGEMENT
// ============================================================================

/**
 * Build an API-ready chat history array for a user/channel/guild.
 *
 * - Merges guild-wide history (if applicable) with per-user history.
 * - Sorts by `timestamp`.
 * - Trims to `STATE_CONFIG.MAX_MESSAGES`.
 * - Injects `[TIME ELAPSED: …]` annotations for gaps ≥ 30 minutes.
 * - Replaces file-data parts with descriptive text (avoids 403 re-access).
 *
 * @param {string}      id       - User, channel, or DM ID.
 * @param {string|null} [guildId] - Optional guild ID for server-wide history merging.
 * @returns {Array<{role:string, parts:Array<{text:string}>}>}
 */
/**
 * L-9 fix: set of history IDs currently being lazily loaded.
 * Prevents duplicate concurrent DB fetches for the same ID.
 * @type {Set<string>}
 */
const _lazyLoadingInProgress = new Set();

// ── Idle eviction ──────────────────────────────────────────────────────────
// chatHistories are lazy-loaded from MongoDB on first access and stay in RAM
// until the process restarts — the primary driver of heap growth on Render.
// This Map tracks the last time each historyId was read or written; the sweep
// below unloads any entry idle for more than 2 hours. The history is still in
// MongoDB and will be re-lazy-loaded transparently on next access.
const _historyLastAccess = new Map();
const HISTORY_IDLE_EVICT_MS = 2 * 60 * 60 * 1_000; // 2 hours

setInterval(() => {
  const now     = Date.now();
  let   evicted = 0;
  for (const [id, lastAccess] of _historyLastAccess.entries()) {
    if (now - lastAccess > HISTORY_IDLE_EVICT_MS && state.chatHistories[id] !== undefined) {
      delete state.chatHistories[id];
      _historyLastAccess.delete(id);
      evicted++;
    }
  }
  if (evicted > 0) logger.info(`History idle eviction: ${evicted} histories unloaded from RAM`);
}, 60 * 60 * 1_000); // sweep every hour

/**
 * Lazy-load a history from DB into state.chatHistories if not already present.
 * L-13 fix: histories not updated in the last 90 days are treated as expired.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function _ensureHistoryLoaded(id) {
  if (state.chatHistories[id] !== undefined) {
    _historyLastAccess.set(id, Date.now()); // refresh on every access
    return;
  }
  if (_lazyLoadingInProgress.has(id)) return;        // concurrent load in progress

  _lazyLoadingInProgress.add(id);
  try {
    const HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1_000; // 90 days
    const raw = await db.getChatHistory(id);

    if (!raw) {
      state.chatHistories[id] = {};
      return;
    }

    // L-13 fix: evict stale histories to keep RAM bounded
    const entries = Object.values(raw).flat().filter(Boolean);
    const lastTs  = entries.reduce((max, m) => Math.max(max, m.timestamp || 0), 0);
    if (lastTs > 0 && Date.now() - lastTs > HISTORY_TTL_MS) {
      logger.debug(`Skipping stale history for ${id} (last activity ${Math.round((Date.now() - lastTs) / 86_400_000)}d ago)`);
      state.chatHistories[id] = {};
      return;
    }

    state.chatHistories[id] = raw;
    _historyLastAccess.set(id, Date.now());
  } catch (err) {
    logger.warn(`Lazy history load failed for ${id}`, err);
    state.chatHistories[id] = {};
  } finally {
    _lazyLoadingInProgress.delete(id);
  }
}

export async function getHistory(id, guildId = null) {
  // L-9: lazy-load both historyIds from DB if not yet in RAM
  await Promise.all([
    _ensureHistoryLoaded(id),
    guildId ? _ensureHistoryLoaded(guildId) : Promise.resolve()
  ]);

  const historyObject = state.chatHistories[id] || {};
  let combined = [];

  // Merge guild history first (chronologically earlier on average).
  if (guildId && state.chatHistories[guildId]) {
    const guildHistory = state.chatHistories[guildId] || {};
    for (const messagesId in guildHistory) {
      if (Object.prototype.hasOwnProperty.call(guildHistory, messagesId)) {
        combined = combined.concat(guildHistory[messagesId] || []);
      }
    }
  }

  // Then user/channel-specific history.
  for (const messagesId in historyObject) {
    if (Object.prototype.hasOwnProperty.call(historyObject, messagesId)) {
      combined = combined.concat(historyObject[messagesId] || []);
    }
  }

  combined = combined.filter(Boolean);
  combined.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  if (combined.length > STATE_CONFIG.MAX_MESSAGES) {
    combined = combined.slice(-STATE_CONFIG.MAX_MESSAGES);
  }

  // Transform to Gemini API format.
  const apiHistory = [];
  let previousTimestamp = null;

  for (const entry of combined) {
    const apiEntry = {
      role:  entry.role === 'assistant' ? 'model' : entry.role,
      parts: []
    };

    // Annotate large time gaps.
    if (previousTimestamp) {
      const diffMs = entry.timestamp - previousTimestamp;
      if (diffMs > STATE_CONFIG.CONTEXT_BREAK_THRESHOLD) {
        apiEntry.parts.push({ text: `[TIME ELAPSED: ${formatDuration(diffMs)} since the previous turn]\n` });
      }
    }
    previousTimestamp = entry.timestamp;

    let userInfoAdded = false;

    if (Array.isArray(entry.content)) {
      for (const part of entry.content) {
        if (part.text !== undefined) {
          let textVal = part.text;

          // Prefix first user text part with display name / username.
          if (!userInfoAdded && entry.role === 'user' && entry.username && entry.displayName) {
            textVal = `[${entry.displayName} (@${entry.username})]: ${textVal}`;
            userInfoAdded = true;
          }

          apiEntry.parts.push({ text: textVal });

        } else if (part.fileUri || part.fileData) {
          // File references expire — replace with a safe text stub.
          const mime = part.mimeType || part.fileData?.mimeType || 'media';
          apiEntry.parts.push({ text: `[Attachment: Previous file (${mime}) — content no longer available]` });

        } else if (part.inlineData) {
          apiEntry.parts.push({ text: '[Attachment: Previous inline image]' });
        }
      }
    }

    if (apiEntry.parts.length > 0) {
      apiHistory.push(apiEntry);
    }
  }

  return apiHistory;
}

/**
 * Append new messages to a user/channel's chat history, tagging each
 * entry with a timestamp and optional user-identity metadata.
 *
 * @param {string}      id           - User, channel, or DM ID.
 * @param {Array}       newHistory   - New history entries from the current turn.
 * @param {string}      messagesId   - Message identifier (usually userId or channelId).
 * @param {string|null} [username]   - Discord username.
 * @param {string|null} [displayName] - Discord display name.
 */
export async function updateChatHistory(id, newHistory, messagesId, username = null, displayName = null) {
  // L-9: ensure this history is loaded from DB before we write to it
  await _ensureHistoryLoaded(id);
  _historyLastAccess.set(id, Date.now()); // keep alive while actively chatting

  if (!state.chatHistories[id]) {
    state.chatHistories[id] = {};
  }
  if (!state.chatHistories[id][messagesId]) {
    state.chatHistories[id][messagesId] = [];
  }

  const now = Date.now();

  const enriched = newHistory.map(entry => {
    const base = { ...entry, timestamp: entry.timestamp || now };

    if (entry.role === 'user' && (username || displayName)) {
      return { ...base, userId: messagesId, username, displayName };
    }
    return base;
  });

  state.chatHistories[id][messagesId] = [
    ...state.chatHistories[id][messagesId],
    ...enriched
  ];

  // Trim the stored array so raw history never grows beyond MAX_MESSAGES.
  // getHistory() already trims on read, but without this the underlying array
  // would grow indefinitely and bloat RAM between reads.
  const stored = state.chatHistories[id][messagesId];
  if (stored.length > STATE_CONFIG.MAX_MESSAGES) {
    state.chatHistories[id][messagesId] = stored.slice(-STATE_CONFIG.MAX_MESSAGES);
  }
}

// ============================================================================
// UTILITY LOOKUPS
// ============================================================================

/**
 * Get the stored response-format preference for a user.
 * Falls back to `BOT_CONFIG.DEFAULT_RESPONSE_FORMAT` ('Normal').
 *
 * @param {string} userId
 * @returns {string} 'Normal' | 'Embedded'
 */
export function getUserResponsePreference(userId) {
  return state.userResponsePreference[userId] || BOT_CONFIG.DEFAULT_RESPONSE_FORMAT;
}

/**
 * Ensure a guild has a blacklist entry and complete server settings.
 * Safe to call multiple times (idempotent).
 *
 * @param {string} guildId
 */
export function initializeBlacklistForGuild(guildId) {
  try {
    if (!state.blacklistedUsers[guildId]) {
      state.blacklistedUsers[guildId] = [];
    }

    if (!state.serverSettings[guildId]) {
      state.serverSettings[guildId] = { ...DEFAULT_SERVER_SETTINGS };
    } else {
      // Back-fill any fields that were added after the guild was originally stored.
      if (!state.serverSettings[guildId].allowedChannels) {
        state.serverSettings[guildId].allowedChannels = [];
      }
      if (state.serverSettings[guildId].showActionButtons === undefined) {
        state.serverSettings[guildId].showActionButtons = false;
      }
      if (state.serverSettings[guildId].continuousReply === undefined) {
        state.serverSettings[guildId].continuousReply = true;
      }
    }
  } catch (error) {
    logger.error(`Error initialising guild ${guildId}`, error);
  }
}

// ============================================================================
// ATTACHMENT CONTEXT PRESERVATION
// ============================================================================

/**
 * Replace file-data references in chat histories with stable text stubs.
 * Called during the daily reset to prevent 403 errors on subsequent turns
 * that try to re-access expired Gemini file URIs.
 *
 * @param {Object} histories - `state.chatHistories`
 */
function preserveAttachmentContext(histories) {
  try {
    Object.values(histories).forEach(subIdEntries => {
      if (typeof subIdEntries !== 'object' || subIdEntries === null) return;

      Object.values(subIdEntries).forEach(messages => {
        if (!Array.isArray(messages)) return;

        messages.forEach(message => {
          if (!message.content) return;

          message.content = message.content.map(item => {
            if (!item.fileData && !item.fileUri) return item;

            const mimeType = item.mimeType || item.fileData?.mimeType || 'unknown';
            const fileName = item.fileName || 'attachment';

            let fileType = 'File';
            if (mimeType.startsWith('image/'))  fileType = 'Image';
            else if (mimeType.startsWith('video/')) fileType = 'Video';
            else if (mimeType.startsWith('audio/')) fileType = 'Audio';
            else if (mimeType.includes('pdf'))   fileType = 'PDF';

            return { text: `[${fileType} was attached: ${fileName} (${mimeType})]` };
          });
        });
      });
    });
  } catch (error) {
    logger.error('Error preserving attachment context', error);
  }
}

// ============================================================================
// DAILY RESET SCHEDULER
// ============================================================================

/**
 * Schedule a daily reset at UTC midnight.
 * Resets image/summary usage counters, preserves attachment context in
 * histories, saves state, then re-schedules itself for the next day.
 */
export function scheduleDailyReset() {
  try {
    const now       = new Date();
    const nextReset = new Date();
    nextReset.setUTCHours(0, 0, 0, 0);
    if (nextReset <= now) nextReset.setUTCDate(nextReset.getUTCDate() + 1);

    const msUntilReset = nextReset - now;

    setTimeout(async () => {
      // chatHistoryLock is imported at the top of this file — no dynamic import needed.
      await chatHistoryLock.runExclusive(async () => {
        logger.info('Executing daily reset…');

        preserveAttachmentContext(state.chatHistories);
        resetImageUsage();
        resetSummaryUsage();
        resetDailyMessageUsage();

        const { resetGemmaKeyDailyCounts } = await import('./ApiKeyManager.js');
        resetGemmaKeyDailyCounts();

        await saveStateToFile();
        logger.info('Daily reset completed');
      });

      scheduleDailyReset(); // reschedule for next midnight
    }, msUntilReset);

    logger.info(`Daily reset scheduled for ${nextReset.toISOString()}`);

  } catch (error) {
    logger.error('Error scheduling daily reset', error);
  }
}

// ============================================================================
// MIGRATION SYSTEM
// ============================================================================

/**
 * Migrate server settings.
 *
 * @param {object}        [opts]
 * @param {string[]|null} [opts.fields]  Only migrate these field keys. null = all fields.
 * @param {boolean}       [opts.force]   true = overwrite field even if server already has it.
 * @returns {Promise<{migrated: number, failed: number}>}
 */
async function migrateAllServerSettings({ fields = null, force = false } = {}) {
  const allServers = await db.getAllServerSettings();
  const serverIds  = Object.keys(allServers);
  if (serverIds.length === 0) return { migrated: 0, failed: 0 };

  let migrated = 0;
  let failed   = 0;

  for (let i = 0; i < serverIds.length; i += MIGRATION_CONFIG.BATCH_SIZE) {
    const batch = serverIds.slice(i, i + MIGRATION_CONFIG.BATCH_SIZE);

    await Promise.all(batch.map(async guildId => {
      try {
        const existing = allServers[guildId] || {};
        let updated;

        if (fields) {
          // Specific-field mode: only touch the requested fields
          updated = { ...existing };
          for (const field of fields) {
            if (field in DEFAULT_SERVER_SETTINGS) {
              if (force || !(field in existing)) {
                updated[field] = DEFAULT_SERVER_SETTINGS[field];
              }
            }
          }
        } else if (force) {
          // Force-all mode: full default overwrite, then re-apply existing non-default fields
          updated = { ...DEFAULT_SERVER_SETTINGS, ...existing };
          // Reset selectedModel to default (original behaviour)
          updated.selectedModel = DEFAULT_SERVER_SETTINGS.selectedModel;
        } else {
          // Default mode: fill in any missing fields only
          updated = { ...DEFAULT_SERVER_SETTINGS, ...existing };
          updated.selectedModel = DEFAULT_SERVER_SETTINGS.selectedModel;
        }

        await db.saveServerSettings(guildId, updated);
        state.serverSettings[guildId] = updated;
        migrated++;
      } catch {
        failed++;
      }
    }));

    if (i + MIGRATION_CONFIG.BATCH_SIZE < serverIds.length) {
      await new Promise(r => setTimeout(r, MIGRATION_CONFIG.BATCH_DELAY_MS));
    }
  }

  return { migrated, failed };
}

/**
 * Migrate user settings.
 *
 * @param {object}        [opts]
 * @param {string[]|null} [opts.fields]  Only migrate these field keys. null = all fields.
 * @param {boolean}       [opts.force]   true = overwrite field even if user already has it.
 * @returns {Promise<{migrated: number, failed: number}>}
 */
async function migrateAllUserSettings({ fields = null, force = false } = {}) {
  const allUsers = await db.getAllUserSettings();
  const userIds  = Object.keys(allUsers);
  if (userIds.length === 0) return { migrated: 0, failed: 0 };

  let migrated = 0;
  let failed   = 0;

  for (let i = 0; i < userIds.length; i += MIGRATION_CONFIG.BATCH_SIZE) {
    const batch = userIds.slice(i, i + MIGRATION_CONFIG.BATCH_SIZE);

    await Promise.all(batch.map(async userId => {
      try {
        const existing = allUsers[userId] || {};
        let updated;

        if (fields) {
          updated = { ...existing };
          for (const field of fields) {
            if (field in DEFAULT_USER_SETTINGS) {
              if (force || !(field in existing)) {
                updated[field] = DEFAULT_USER_SETTINGS[field];
              }
            }
          }
        } else if (force) {
          updated = { ...DEFAULT_USER_SETTINGS, ...existing };
          updated.selectedModel = DEFAULT_USER_SETTINGS.selectedModel;
        } else {
          updated = { ...DEFAULT_USER_SETTINGS, ...existing };
          updated.selectedModel = DEFAULT_USER_SETTINGS.selectedModel;
        }

        await db.saveUserSettings(userId, updated);
        state.userSettings[userId] = updated;
        migrated++;
      } catch {
        failed++;
      }
    }));

    if (i + MIGRATION_CONFIG.BATCH_SIZE < userIds.length) {
      await new Promise(r => setTimeout(r, MIGRATION_CONFIG.BATCH_DELAY_MS));
    }
  }

  return { migrated, failed };
}

/**
 * Run migrations with full control over scope, fields, and force-overwrite.
 *
 * @param {object}             [opts]
 * @param {'servers'|'users'|'both'} [opts.scope]   Which settings to migrate. Default: 'both'.
 * @param {string[]|null}      [opts.fields]         Field keys to migrate. null = all.
 * @param {boolean}            [opts.force]          Overwrite even if the field already exists.
 * @returns {Promise<{ servers?: object, users?: object, message: string }>}
 */
export async function runMigration({ scope = 'both', fields = null, force = false } = {}) {
  const opts = { fields, force };
  let serverRes, userRes;

  if (scope === 'servers' || scope === 'both') {
    serverRes = await migrateAllServerSettings(opts);
    logger.info(`Migration (servers) — migrated: ${serverRes.migrated}, failed: ${serverRes.failed}`);
  }

  if (scope === 'users' || scope === 'both') {
    userRes = await migrateAllUserSettings(opts);
    logger.info(`Migration (users)   — migrated: ${userRes.migrated}, failed: ${userRes.failed}`);
  }

  await saveStateToFile();

  const parts = [];
  if (serverRes) parts.push(`Servers: ${serverRes.migrated} migrated, ${serverRes.failed} failed`);
  if (userRes)   parts.push(`Users: ${userRes.migrated} migrated, ${userRes.failed} failed`);

  return {
    servers: serverRes || null,
    users:   userRes   || null,
    message: parts.join(' | '),
  };
}

/**
 * Run all pending migrations (server + user settings).
 * No-ops when `MIGRATION_CONFIG.ENABLE_MIGRATION` is `false`.
 *
 * @returns {Promise<void>}
 */
export async function runMigrations() {
  if (!MIGRATION_CONFIG.ENABLE_MIGRATION) return;

  try {
    logger.warn('Migration is ENABLED — updating all settings to latest defaults…');

    const [serverRes, userRes] = await Promise.all([
      migrateAllServerSettings(),
      migrateAllUserSettings()
    ]);

    logger.info(`Migration summary — Servers: ${serverRes.migrated} migrated, ${serverRes.failed} failed`);
    logger.info(`Migration summary — Users: ${userRes.migrated} migrated, ${userRes.failed} failed`);

    await saveStateToFile();
    logger.info('Migration completed — set MIGRATION_CONFIG.ENABLE_MIGRATION = false to prevent re-run');

  } catch (error) {
    logger.error('Migration failed', error);
    throw error;
  }
}
