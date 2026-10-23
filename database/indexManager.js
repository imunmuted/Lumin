/**
 * @fileoverview Database index creation. Runs once in the background after
 *               connection is established. Safe to call multiple times —
 *               duplicate-key errors (codes 85/86) are silently ignored.
 * @module database/indexManager
 */

import { Logger }                              from '../core/Logger.js';
import { COLLECTIONS, getCollection,
         indexesCreated, setIndexesCreated, getDB }   from './connection.js';

const logger = Logger.get('IndexManager');

/**
 * Create application indexes once after connecting to MongoDB. Legacy memory
 * vector indexes are intentionally no longer created; existing DB records are
 * left intact for a separately reviewed migration/retention decision.
 */
export async function createIndexes() {
  if (indexesCreated) return;
  try {
    logger.info('Creating Helium database indexes…');
    const ops = [
      { col: COLLECTIONS.USER_SETTINGS,       idx: { userId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.SERVER_SETTINGS,     idx: { guildId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.CHAT_HISTORIES,      idx: { id: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.CUSTOM_INSTRUCTIONS, idx: { id: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.BLACKLISTED_USERS,   idx: { guildId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.CHANNEL_SETTINGS,    idx: { channelId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.IMAGE_USAGE,         idx: { userId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.BIRTHDAYS,           idx: { userId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.REMINDERS,           idx: { userId: 1, id: 1 } },
      { col: COLLECTIONS.DAILY_QUOTES,        idx: { userId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.ROULETTE,             idx: { channelId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.COMPLIMENTS,          idx: { userId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.USER_TIMEZONES,       idx: { userId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.SERVER_DIGESTS,       idx: { guildId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.REALIVE,              idx: { guildId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.SUMMARY_USAGE,        idx: { userId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.QUOTE_USAGE,           idx: { userId: 1 }, opts: { unique: true } },
      { col: COLLECTIONS.USER_FACTS,            idx: { userId: 1, createdAt: -1 } },
      { col: COLLECTIONS.DAILY_MSG_USAGE,       idx: { date: 1 }, opts: { unique: true } },
      { col: 'settingDefaults',                 idx: { _id: 1 } },
      { col: 'migrationRuns',                   idx: { startedAt: -1 } },
      { col: 'migrationSnapshots',              idx: { migrationId: 1, status: 1, createdAt: -1 } },
      { col: 'consoleAuditLogs',                idx: { at: -1, actor: 1 } },
      { col: 'consoleRoleAssignmentState',      idx: { updatedAt: -1 } },
    ];
    const results = await Promise.allSettled(ops.map(({ col, idx, opts = {} }) => getCollection(col).createIndex(idx, opts)));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected' && result.reason?.code !== 85 && result.reason?.code !== 86) {
        logger.warn(`Failed to create index on ${ops[i].col}: ${result.reason?.message || 'unknown error'}`);
      }
    }
    setIndexesCreated(true);
    logger.info('Helium database indexes created');
  } catch (error) {
    logger.error('Critical error during index creation', error);
  }
}
