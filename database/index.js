/**
 * @fileoverview Database barrel. Re-exports everything from all sub-modules so
 *               callers can keep using:
 *                 import * as db from '../database/index.js'
 *               or the root shim:
 *                 import * as db from '../database.js'
 *
 * Export order mirrors the original database.js public surface so diff-tools
 * show zero logical changes.
 * @module database
 */

// ── Connection & infrastructure ───────────────────────────────────────────
export { connectDB, closeDB, getDB } from './connection.js';

// ── Lightweight feature lookups (not memory retrieval) ────────────────────
export { getBirthday, getUserReminders, getComplimentCount, getUserDailyQuote } from './collections/contextLookups.js';

// ── Settings ──────────────────────────────────────────────────────────────
export {
  saveUserSettings,
  getUserSettings,
  getAllUserSettings,
  saveServerSettings,
  getServerSettings,
  getAllServerSettings,
  saveCustomInstructions,
  getCustomInstructions,
  getAllCustomInstructions,
  saveBlacklistedUsers,
  getBlacklistedUsers,
  getAllBlacklistedUsers,
  saveChannelSetting,
  getChannelSetting,
  getAllChannelSettings,
  saveActiveUsersInChannels,
  getActiveUsersInChannels,
  saveUserResponsePreference,
  getUserResponsePreference,
  getAllUserResponsePreferences
} from './collections/settingsRepo.js';

// ── Chat histories ────────────────────────────────────────────────────────
export {
  saveChatHistory,
  getChatHistory,
  getAllChatHistories,
  deleteChatHistory
} from './collections/historyRepo.js';

// Legacy vector-memory collections are deliberately not exposed by the active repository facade.
// Existing MongoDB records are left untouched for a separately reviewed retention migration.

// ── Feature collections ───────────────────────────────────────────────────
export {
  saveBirthday,
  getAllBirthdays,
  deleteBirthday,
  saveReminder,
  getAllReminders,
  updateReminder,
  deleteReminder,
  saveDailyQuote,
  getAllDailyQuotes,
  deleteDailyQuote,
  saveRouletteConfig,
  getAllRouletteConfigs,
  saveComplimentCount,
  getAllComplimentCounts,
  saveComplimentOptOut,
  getAllComplimentOptOuts,
  saveUserTimezone,
  getUserTimezone,
  getAllUserTimezones,
  saveServerDigest,
  getServerDigest,
  getAllServerDigests,
  saveRealiveConfig,
  getAllRealiveConfigs
} from './collections/featuresRepo.js';

// ── Usage tracking + user facts ───────────────────────────────────────────
export {
  saveImageUsage,
  getAllImageUsages,
  saveQuoteUsage,
  getQuoteUsage,
  getAllQuoteUsages,
  saveSummaryUsage,
  getAllSummaryUsages,
  saveUserFact,
  getUserFacts,
  deleteUserFact,
  deleteAllUserFacts,
  saveServerFact,
  getServerFacts,
  getServerFactsCategorized,
  getServerFactsMultiGuild,
  deleteServerFact,
  deleteAllServerFacts,
  deleteUserSessionSummaries,
  saveIndexedCount,
  getIndexedCounts
} from './collections/usageRepo.js';

// ── Batch helper ──────────────────────────────────────────────────────────
export { batchSave } from './batchSave.js';
