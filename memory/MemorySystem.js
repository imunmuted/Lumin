/**
 * @fileoverview Minimal memory compatibility facade.
 *
 * Helium deliberately stores chat history but does not index, embed, summarize,
 * or retrieve long-term conversational memory. Conversation history is read
 * from persistent storage and only the latest five individual messages are
 * sent to the model. This facade keeps the small set of historical APIs used
 * by commands so a future memory implementation can replace this module
 * without touching the Discord message pipeline.
 *
 * Legacy vector collections are left untouched; this module never queries or
 * writes them. A later, explicit migration can archive or delete them.
 */

import * as db from '../database/index.js';
import { state } from '../managers/StateManager.js';
import { Logger } from '../core/Logger.js';

const logger = Logger.get('MemorySystem');
const CONTEXT_MESSAGE_LIMIT = 5;
const MAX_PROFILE_TEXT = 8_000;

import { extractText, flattenHistory, sanitizeForModel, getLatestModelContext } from './historyContext.js';

class MemorySystem {
  async init() {
    logger.info('Basic memory facade ready; vector indexing and retrieval are disabled');
  }

  /** Fetch saved history and return at most the last five provider-valid stored messages. */
  async getOptimizedHistory(historyId) {
    if (!historyId) return [];
    try {
      let stored = await db.getChatHistory(historyId);
      if (!stored) stored = state.chatHistories?.[historyId] ?? null;
      if (!stored) return [];
      return getLatestModelContext(stored, CONTEXT_MESSAGE_LIMIT);
    } catch (error) {
      logger.error('Failed to load conversation history', error);
      // Degraded mode: prefer the already-loaded state rather than making an
      // AI request depend on a second database read succeeding.
      return getLatestModelContext(state.chatHistories?.[historyId], CONTEXT_MESSAGE_LIMIT);
    }
  }

  /**
   * Lightweight lexical search over persisted chat history for explicit tool
   * calls. This deliberately does not create embeddings or search vector stores.
   * Normal chat still receives only the latest five stored messages.
   */
  async searchConversationHistory(historyId, query, { limit = 5, sinceMs = 0 } = {}) {
    if (!historyId || typeof query !== 'string' || !query.trim()) return [];
    const safeLimit = Math.max(1, Math.min(10, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 5));
    const queryText = query.toLowerCase().slice(0, 500).trim();
    const terms = [...new Set(queryText.split(/[^\p{L}\p{N}_-]+/u).filter(term => term.length >= 2))].slice(0, 12);
    if (!terms.length) return [];
    try {
      let stored = state.chatHistories?.[historyId] ?? null;
      if (!stored || Object.keys(stored).length === 0) stored = await db.getChatHistory(historyId);
      const messages = flattenHistory(stored).filter(entry => entry && (entry.role === 'user' || entry.role === 'assistant' || entry.role === 'model'));
      const scored = [];
      for (const message of messages) {
        const timestamp = Number(message.timestamp || 0);
        if (sinceMs && timestamp < sinceMs) continue;
        const text = extractText(message).trim();
        if (!text) continue;
        const normalized = text.toLowerCase();
        const matches = terms.filter(term => normalized.includes(term));
        if (!matches.length) continue;
        const phraseBonus = normalized.includes(queryText) ? 3 : 0;
        scored.push({
          role: message.role === 'assistant' || message.role === 'model' ? 'assistant' : 'user',
          text: text.slice(0, 1_000),
          timestamp: timestamp || null,
          score: matches.length + phraseBonus,
        });
      }
      return scored.sort((a, b) => b.score - a.score || (b.timestamp || 0) - (a.timestamp || 0)).slice(0, safeLimit);
    } catch (error) {
      logger.error('Failed to search saved conversation history', error);
      return [];
    }
  }

  /** Return the best lexical match to help tools answer timestamp questions. */
  async findHistoryMessage(historyId, query) {
    return (await this.searchConversationHistory(historyId, query, { limit: 1 }))[0] ?? null;
  }

  /** Legacy compatibility: vector/RAG retrieval is intentionally disabled. */
  async searchMemory() { return []; }

  /** No-op compatibility method; conversational messages are stored as history only. */
  async storeMemoryWithEmbedding() {
    return false;
  }

  async forceRebuildClusters() {
    return { ok: false, reason: 'long_term_memory_disabled' };
  }

  async forceIndexNow() {
    return { ok: false, reason: 'long_term_memory_disabled' };
  }

  invalidatePersonalDataCache() {
    // The replacement facade does not cache personal data in process memory.
  }

  async addPersonalData(userId, fact) {
    if (!userId || typeof fact !== 'string' || !fact.trim() || fact.length > 2_000) return false;
    try {
      await db.saveUserFact(userId, fact.trim());
      return true;
    } catch (error) {
      logger.error('Failed to save explicit user fact', error);
      return false;
    }
  }

  async removePersonalData(userId, keyword) {
    if (!userId || typeof keyword !== 'string' || !keyword.trim()) return false;
    try {
      const deleted = await db.deleteUserFact(userId, keyword.trim());
      return Number(deleted) > 0;
    } catch (error) {
      logger.error('Failed to remove explicit user fact', error);
      return false;
    }
  }

  /**
   * Return explicitly stored personal facts for direct user-requested tools.
   * This data is not injected into ordinary chat context.
   */
  async getUserPersonalData(userId) {
    if (!userId) return null;
    try {
      const facts = await db.getUserFacts(userId);
      const text = (Array.isArray(facts) ? facts : [])
        .map((entry) => typeof entry === 'string' ? entry : entry?.fact ?? entry?.text ?? '')
        .filter(Boolean)
        .join('\n')
        .slice(0, MAX_PROFILE_TEXT);
      return text ? { text, timestamp: Date.now(), embedding: null } : null;
    } catch (error) {
      logger.error('Failed to load explicit user facts', error);
      return null;
    }
  }
}

export const memorySystem = new MemorySystem();
