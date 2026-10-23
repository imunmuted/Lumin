/**
 * @fileoverview Chat history persistence — saves per-message or batch turns to DB
 *               to MongoDB. Long-term memory indexing is deliberately disabled.
 * @module modules/message/HistoryManager
 */

import { getHistoryLock, updateChatHistory, state } from '../../managers/BotManager.js';
import * as db        from '../../database.js';
import { Logger }      from '../../core/Logger.js';

const logger = Logger.get('HistoryManager');

/**
 * @typedef {Object} PreparedMessage
 * @property {import('discord.js').Message} message
 * @property {string}  messageContent
 * @property {number}  timestamp
 */

/**
 * Persist the conversation turn to in-memory state and the database.
 * Handles both single messages and batched multi-message turns.
 *
 * Uses a targeted `db.saveChatHistory` call rather than the expensive
 * `saveStateToFile()` which dumps all state while holding the lock.
 *
 * @param {object} params
 * @param {string}               params.historyId
 * @param {string}               params.userId
 * @param {string|null}          params.guildId
 * @param {object[]}             params.newHistory        Full turn [{role, content}]
 * @param {string}               params.finalResponse     Final AI text
 * @param {string}               params.botMessageId      Discord message ID of the reply
 * @param {import('discord.js').Message} params.originalMessage
 * @param {PreparedMessage[]|null} params.preparedMessages Non-null for batch turns
 * @returns {Promise<void>}
 */
export async function saveMessageHistory({
  historyId,
  userId,
  guildId,
  newHistory,
  finalResponse,
  botMessageId,
  originalMessage,
  preparedMessages = null
}) {
  // M-10 fix: per-historyId lock — User A's save no longer blocks User B's
  const lock = getHistoryLock(historyId);
  await lock.runExclusive(async () => {
    try {
      if (preparedMessages?.length > 1) {
        // ── Batched turn: persist each user message individually ─────────
        logger.debug(`Saving ${preparedMessages.length} batched messages individually`);

        for (let i = 0; i < preparedMessages.length; i++) {
          const prepared = preparedMessages[i];
          const msg      = prepared.message;
          const isLast   = i === preparedMessages.length - 1;

          const userEntry = {
            role:      'user',
            content:   [{ text: prepared.messageContent }],
            timestamp: prepared.timestamp
          };

          // Prefer server-specific display name (nickname if set, else globalName, else username)
          // over the account-level author.displayName so history entries show exactly
          // the name everyone on this server sees for this person.
          const msgDisplayName = msg.member?.displayName
            ?? msg.author.globalName
            ?? msg.author.displayName;

          if (isLast) {
            // Last message carries both user entry and the assistant response
            updateChatHistory(
              historyId,
              [
                userEntry,
                { role: 'assistant', content: [{ text: finalResponse }], timestamp: Date.now() }
              ],
              botMessageId,
              msg.author.username,
              msgDisplayName
            );
          } else {
            // Earlier messages in the batch: user entry only
            updateChatHistory(
              historyId,
              [userEntry],
              msg.id,
              msg.author.username,
              msgDisplayName
            );
          }
        }
      } else {
        // ── Single turn ─────────────────────────────────────────────────
        const origDisplayName = originalMessage.member?.displayName
          ?? originalMessage.author.globalName
          ?? originalMessage.author.displayName;
        updateChatHistory(
          historyId,
          newHistory,
          botMessageId,
          originalMessage.author.username,
          origDisplayName
        );
      }

      // Chat history is the sole automatic conversational context store.

      // Automatic session-memory summarization is disabled. Persistent history
      // is the context source; future memory work plugs in behind MemorySystem.

      // L-7 fix: guard against saving undefined history (uninitialized historyId)
      const historyToSave = state.chatHistories[historyId];
      if (historyToSave) {
        try {
          // Await the targeted write while the per-history lock is held. This
          // prevents a later turn from racing and overwriting a newer snapshot.
          await db.saveChatHistory(historyId, historyToSave);
        } catch (err) {
          // Keep the bot responsive during a database outage; the failure is
          // visible in logs, and the next turn can retry persisting the state.
          logger.error(`Failed to save chat history for ${historyId}`, err);
        }
      }

    } catch (err) {
      logger.error('Error inside history save lock', err);
    }
  });
}
