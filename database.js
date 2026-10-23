/**
 * @fileoverview Root-level compatibility shim.
 *
 * All existing callers that do:
 *   import * as db from './database.js'
 *   import db from './database.js'
 *   import { saveChatHistory } from './database.js'
 *
 * continue to work without any change. This file simply re-exports everything
 * from the database/ package and provides the same default export object that
 * the original database.js had.
 *
 * @module database (shim)
 */

export * from './database/index.js';

import {
  connectDB, closeDB, getDB,
  getBirthday, getUserReminders, getComplimentCount, getUserDailyQuote,
  saveUserSettings, getUserSettings, getAllUserSettings,
  saveServerSettings, getServerSettings, getAllServerSettings,
  saveChatHistory, getChatHistory, getAllChatHistories, deleteChatHistory,
  saveCustomInstructions, getCustomInstructions, getAllCustomInstructions,
  saveBlacklistedUsers, getBlacklistedUsers, getAllBlacklistedUsers,
  saveChannelSetting, getChannelSetting, getAllChannelSettings,
  saveActiveUsersInChannels, getActiveUsersInChannels,
  saveUserResponsePreference, getUserResponsePreference, getAllUserResponsePreferences,
  saveImageUsage, getAllImageUsages,
  saveBirthday, getAllBirthdays, deleteBirthday,
  saveReminder, getAllReminders, updateReminder, deleteReminder,
  saveDailyQuote, getAllDailyQuotes, deleteDailyQuote,
  saveRouletteConfig, getAllRouletteConfigs,
  saveComplimentCount, getAllComplimentCounts,
  saveComplimentOptOut, getAllComplimentOptOuts,
  saveUserTimezone, getUserTimezone, getAllUserTimezones,
  saveServerDigest, getServerDigest, getAllServerDigests,
  saveQuoteUsage, getQuoteUsage, getAllQuoteUsages,
  saveRealiveConfig, getAllRealiveConfigs,
  saveSummaryUsage, getAllSummaryUsages,
  saveUserFact, getUserFacts, deleteUserFact,
  batchSave
} from './database/index.js';

/** Default export mirrors the original database.js `export default {}` object. */
export default {
  connectDB, closeDB, getDB,
  getBirthday, getUserReminders, getComplimentCount, getUserDailyQuote,
  saveUserSettings, getUserSettings, getAllUserSettings,
  saveServerSettings, getServerSettings, getAllServerSettings,
  saveChatHistory, getChatHistory, getAllChatHistories, deleteChatHistory,
  saveCustomInstructions, getCustomInstructions, getAllCustomInstructions,
  saveBlacklistedUsers, getBlacklistedUsers, getAllBlacklistedUsers,
  saveChannelSetting, getChannelSetting, getAllChannelSettings,
  saveActiveUsersInChannels, getActiveUsersInChannels,
  saveUserResponsePreference, getUserResponsePreference, getAllUserResponsePreferences,
  saveImageUsage, getAllImageUsages,
  saveBirthday, getAllBirthdays, deleteBirthday,
  saveReminder, getAllReminders, updateReminder, deleteReminder,
  saveDailyQuote, getAllDailyQuotes, deleteDailyQuote,
  saveRouletteConfig, getAllRouletteConfigs,
  saveComplimentCount, getAllComplimentCounts,
  saveComplimentOptOut, getAllComplimentOptOuts,
  saveUserTimezone, getUserTimezone, getAllUserTimezones,
  saveServerDigest, getServerDigest, getAllServerDigests,
  saveQuoteUsage, getQuoteUsage, getAllQuoteUsages,
  saveRealiveConfig, getAllRealiveConfigs,
  saveSummaryUsage, getAllSummaryUsages,
  saveUserFact, getUserFacts, deleteUserFact,
  batchSave
};
