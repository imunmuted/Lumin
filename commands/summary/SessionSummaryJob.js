/**
 * @fileoverview Session Memory Summary System.
 *
 * How it works:
 *   • The bot tracks bot-message counts per (userId, historyId) in memory.
 *   • Every 50 bot messages a summary is generated covering the PREVIOUS 50 bot
 *     messages (i.e. messages 1-50 are summarised when message 100 is sent).
 *   • Instead of creating a new doc each window, the EXISTING session summary
 *     for this user+historyId is fetched, the new window is merged in, and the
 *     single document is updated in place — one doc per conversation, always current.
 *   • First-person voice: "I told her...", "We talked about...", "I noticed..."
 *   • One embedding per update — reused by search_memory (last 24 h) and
 *     check_sessions (older sessions via vector search).
 *   • After 24 hours the daily digest job collapses old sessions into one entry.
 *
 * @module commands/summary/SessionSummaryJob
 */

import { Logger }                     from '../../core/Logger.js';
import * as db                        from '../../database/index.js';
import { genAI }                      from '../../managers/BotManager.js';
import { embeddingService }           from '../../memory/EmbeddingService.js';
import { redisCache }                 from '../../memory/RedisCache.js';
import { getCollection, COLLECTIONS } from '../../database/connection.js';
import { extractTextFromMessage }     from '../../memory/memoryUtils.js';
import { SYSTEM_AGENT_CALLSIGN }      from '../../modules/config.js';

const logger = Logger.get('SessionSummaryJob');

// ============================================================================
// CONSTANTS
// ============================================================================

// Gemma 3 12B — capable enough for coherent first-person memory prose,
// cheap enough to run after every 50-message window.
const SUMMARY_MODEL          = 'gemma-3-12b-it';
const REDIS_SESSION_TTL      = 25 * 60 * 60;        // 25 h
const REDIS_KEY_PREFIX       = 'lumin:session:';
const BOT_MSGS_PER_SUMMARY   = 50;
const MAX_MSGS_IN_WINDOW     = 120;
const DAILY_DIGEST_CUTOFF_MS = 24 * 60 * 60 * 1_000;

// ============================================================================
// IN-MEMORY BOT MESSAGE COUNTERS
// ============================================================================

const botMsgCounters = new Map();

export function incrementBotMsgCounter(userId, historyId) {
  const key = `${userId}:${historyId}`;
  const n   = (botMsgCounters.get(key) ?? 0) + 1;
  botMsgCounters.set(key, n);
  return n;
}

export function getBotMsgCounter(userId, historyId) {
  return botMsgCounters.get(`${userId}:${historyId}`) ?? 0;
}

// ============================================================================
// PROMPTS
// ============================================================================

const SESSION_SUMMARY_SYSTEM_PROMPT = `You are writing a first-person memory log for an AI assistant named ${SYSTEM_AGENT_CALLSIGN}.
Summarise the conversation excerpt below as ${SYSTEM_AGENT_CALLSIGN} recalling what happened.

STRICT RULES:
- Write entirely in first person ("I", "we", "my").
- Be specific and concrete — names, topics, dates, decisions.
- Keep it under 200 words.
- Start directly with the summary, no preamble.
- Plain paragraphs only, no bullet points or headers.

Example tone:
"I helped Alex debug a Python script that was crashing on startup. We found a missing import and fixed it together. They mentioned they're working on a Discord bot for their school project. I also told them about using asyncio properly for concurrent tasks."`;

const SESSION_MERGE_SYSTEM_PROMPT = `You are updating a first-person memory log for an AI assistant named ${SYSTEM_AGENT_CALLSIGN}.
You are given an EXISTING SUMMARY and a NEW CONVERSATION excerpt.
Merge them into one updated summary that covers everything.

STRICT RULES:
- Write entirely in first person ("I", "we", "my").
- Preserve all important details from the existing summary.
- Naturally add new developments from the new conversation.
- Keep it under 300 words total.
- Start directly with the merged summary, no preamble.
- Plain paragraphs only, no bullet points or headers.`;

// ============================================================================
// REDIS HELPERS
// ============================================================================

async function redisSaveSession(key, text) {
  try { await redisCache.rawSet(`${REDIS_KEY_PREFIX}${key}`, text, REDIS_SESSION_TTL); }
  catch { /* non-fatal */ }
}

async function redisGetSession(key) {
  try { return await redisCache.rawGet(`${REDIS_KEY_PREFIX}${key}`); }
  catch { return null; }
}

// ============================================================================
// MONGODB HELPERS
// ============================================================================

/**
 * Upsert the session summary for this user+historyId.
 * One document per conversation — updated in place each window.
 */
async function upsertSessionSummary(userId, historyId, text, embedding, windowEnd) {
  try {
    await getCollection(COLLECTIONS.SESSION_SUMMARIES).updateOne(
      { userId, historyId, isDailyDigest: false },
      {
        $set: {
          text,
          embedding,
          windowEnd,
          updatedAt: new Date(),
          timestamp: Date.now()
        },
        $setOnInsert: {
          userId,
          historyId,
          isDailyDigest: false,
          createdAt:     new Date()
        }
      },
      { upsert: true }
    );
  } catch (err) {
    logger.error('Failed to upsert session summary', err);
  }
}

/**
 * Fetch the current session doc for a user+historyId (null if none yet).
 */
async function getExistingSessionSummary(userId, historyId) {
  try {
    return await getCollection(COLLECTIONS.SESSION_SUMMARIES).findOne(
      { userId, historyId, isDailyDigest: false },
      { projection: { text: 1, windowEnd: 1, timestamp: 1 } }
    );
  } catch { return null; }
}

export async function getSessionSummaries(userId, sinceMs = 0, limit = 20) {
  try {
    return await getCollection(COLLECTIONS.SESSION_SUMMARIES)
      .find({ userId, timestamp: { $gte: sinceMs }, isDailyDigest: false })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    logger.error('getSessionSummaries failed', err);
    return [];
  }
}

export async function vectorSearchOldSessions(userId, queryEmbedding, limit = 5, olderThanMs) {
  const cutoff = olderThanMs ?? (Date.now() - DAILY_DIGEST_CUTOFF_MS);
  try {
    const pipeline = [
      {
        $vectorSearch: {
          index:         'sessionSummaries_vector',
          path:          'embedding',
          queryVector:   queryEmbedding,
          numCandidates: limit * 10,
          limit:         limit * 2,
          filter:        { userId: { $eq: userId } }
        }
      },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      { $match: { timestamp: { $lte: cutoff }, isDailyDigest: false } },
      { $sort: { score: -1 } },
      { $limit: limit },
      { $project: { _id: 0, text: 1, score: 1, timestamp: 1, historyId: 1 } }
    ];
    return await getCollection(COLLECTIONS.SESSION_SUMMARIES).aggregate(pipeline).toArray();
  } catch (err) {
    logger.warn('vectorSearchOldSessions: vector index unavailable, falling back', err.message);
    try {
      return await getCollection(COLLECTIONS.SESSION_SUMMARIES)
        .find({ userId, timestamp: { $lte: cutoff }, isDailyDigest: false })
        .sort({ timestamp: -1 })
        .limit(limit)
        .project({ _id: 0, text: 1, score: 1, timestamp: 1, historyId: 1 })
        .toArray();
    } catch { return []; }
  }
}

// ============================================================================
// SUMMARY GENERATION
// ============================================================================

async function generateSessionSummaryText(messages) {
  if (!messages?.length) return null;
  try {
    const transcript = messages
      .map(m => {
        const role = m.role === 'assistant' ? SYSTEM_AGENT_CALLSIGN : 'User';
        const text = extractTextFromMessage(m);
        return text ? `${role}: ${text}` : null;
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000);

    if (!transcript.trim()) return null;

    const result = await genAI.models.generateContent({
      model:    SUMMARY_MODEL,
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      config:   { systemInstruction: SESSION_SUMMARY_SYSTEM_PROMPT, temperature: 0.3, maxOutputTokens: 350 }
    });

    return result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    logger.error('generateSessionSummaryText failed', err);
    return null;
  }
}

/**
 * Merge an existing summary with a new message window into one updated summary.
 */
async function mergeSessionSummary(existingText, newMessages) {
  if (!newMessages?.length) return existingText;
  try {
    const newTranscript = newMessages
      .map(m => {
        const role = m.role === 'assistant' ? SYSTEM_AGENT_CALLSIGN : 'User';
        const text = extractTextFromMessage(m);
        return text ? `${role}: ${text}` : null;
      })
      .filter(Boolean)
      .join('\n')
      .slice(0, 6000);

    if (!newTranscript.trim()) return existingText;

    const userContent = `EXISTING SUMMARY:\n${existingText}\n\nNEW CONVERSATION:\n${newTranscript}`;

    const result = await genAI.models.generateContent({
      model:    SUMMARY_MODEL,
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      config:   { systemInstruction: SESSION_MERGE_SYSTEM_PROMPT, temperature: 0.3, maxOutputTokens: 450 }
    });

    return result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || existingText;
  } catch (err) {
    logger.error('mergeSessionSummary failed — keeping old summary', err);
    return existingText;
  }
}

// ============================================================================
// MAIN TRIGGER
// ============================================================================

/**
 * Check if a session summary should be generated/updated and do so async.
 *
 * At counter=100: creates fresh summary for window 1-50.
 * At counter=150: loads existing doc, merges window 51-100 in, updates in place.
 * At counter=200: loads existing doc, merges window 101-150 in, updates in place.
 * etc.
 */
export function maybeGenerateSessionSummary(userId, historyId, guildId, getHistory) {
  const counter = getBotMsgCounter(userId, historyId);

  if (counter < BOT_MSGS_PER_SUMMARY * 2 || counter % BOT_MSGS_PER_SUMMARY !== 0) return;

  const windowIndex = (counter / BOT_MSGS_PER_SUMMARY) - 1;
  const windowStart = (windowIndex - 1) * BOT_MSGS_PER_SUMMARY + 1;
  const windowEnd   =  windowIndex      * BOT_MSGS_PER_SUMMARY;

  _generateAndStore(userId, historyId, getHistory, windowStart, windowEnd)
    .catch(err => logger.error('maybeGenerateSessionSummary background task failed', err));
}

async function _generateAndStore(userId, historyId, getHistory, windowStart, windowEnd) {
  try {
    const allMessages = await getHistory();
    if (!allMessages?.length) return;

    // Slice out the bot-message window to summarise
    let botTurnsSeen = 0;
    const windowMessages = [];
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (msg.role === 'assistant') {
        botTurnsSeen++;
        if (botTurnsSeen >= windowStart && botTurnsSeen <= windowEnd) {
          if (i > 0 && allMessages[i - 1].role === 'user' &&
              !windowMessages.includes(allMessages[i - 1])) {
            windowMessages.push(allMessages[i - 1]);
          }
          windowMessages.push(msg);
        }
        if (botTurnsSeen > windowEnd) break;
      }
    }

    const limitedMsgs = windowMessages.slice(-MAX_MSGS_IN_WINDOW);
    if (!limitedMsgs.length) return;

    // Load existing doc — may be null on very first trigger
    const existing = await getExistingSessionSummary(userId, historyId);

    let summaryText;
    if (existing?.text) {
      summaryText = await mergeSessionSummary(existing.text, limitedMsgs);
    } else {
      summaryText = await generateSessionSummaryText(limitedMsgs);
    }

    if (!summaryText) return;

    // Single embedding — reused by both search_memory and check_sessions
    const embedding = await embeddingService
      .generateEmbedding(summaryText, 'RETRIEVAL_DOCUMENT')
      .catch(() => null);

    await upsertSessionSummary(userId, historyId, summaryText, embedding, windowEnd);
    await redisSaveSession(`${userId}:${historyId}`, summaryText);

    logger.info(`Session summary updated — user ${userId}, window up to ${windowEnd}`);
  } catch (err) {
    logger.error('_generateAndStore failed', err);
  }
}

// ============================================================================
// DAILY DIGEST
// ============================================================================

export async function runDailyDigestJob() {
  logger.info('Daily session digest job starting…');
  try {
    const cutoff  = Date.now() - DAILY_DIGEST_CUTOFF_MS;
    const userIds = await getCollection(COLLECTIONS.SESSION_SUMMARIES)
      .distinct('userId', { timestamp: { $lte: cutoff }, isDailyDigest: false });

    let done = 0;
    for (const userId of userIds) {
      try {
        const old = await getCollection(COLLECTIONS.SESSION_SUMMARIES)
          .find({ userId, timestamp: { $lte: cutoff }, isDailyDigest: false })
          .sort({ timestamp: 1 })
          .toArray();

        if (!old.length) continue;

        const combined = old.map(d => d.text).join('\n\n');
        const digest   = await generateSessionSummaryText([{
          role:    'assistant',
          content: [{ text: `[Sessions to compress]\n\n${combined}` }]
        }]);
        if (!digest) continue;

        const embedding = await embeddingService
          .generateEmbedding(digest, 'RETRIEVAL_DOCUMENT')
          .catch(() => null);

        await getCollection(COLLECTIONS.SESSION_SUMMARIES).insertOne({
          userId,
          historyId:     old[0].historyId,
          text:          digest,
          embedding,
          windowEnd:     old[old.length - 1].windowEnd,
          isDailyDigest: true,
          digestOf:      old.map(d => d._id),
          createdAt:     new Date(),
          timestamp:     cutoff
        });

        await getCollection(COLLECTIONS.SESSION_SUMMARIES).updateMany(
          { _id: { $in: old.map(d => d._id) } },
          { $set: { digestedAt: new Date() } }
        );
        done++;
      } catch (err) {
        logger.error(`Digest failed for user ${userId}`, err);
      }
    }
    logger.info(`Daily digest complete — ${done}/${userIds.length} users processed`);
  } catch (err) {
    logger.error('runDailyDigestJob crashed', err);
  }
}

export function scheduleDailyDigestJob() {
  const msUntil = _msUntilNext3AM();
  logger.info(`Daily digest job scheduled in ${Math.round(msUntil / 3_600_000)}h`);
  setTimeout(async () => {
    await runDailyDigestJob();
    scheduleDailyDigestJob();
  }, msUntil);
}

function _msUntilNext3AM() {
  const now       = new Date();
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0, 0
  ));
  if (candidate.getTime() > now.getTime()) {
    return Math.max(candidate.getTime() - now.getTime(), 60_000);
  }
  candidate.setUTCDate(candidate.getUTCDate() + 1);
  return Math.max(candidate.getTime() - now.getTime(), 60_000);
}

// ============================================================================
// RECENT SESSION CONTEXT (last 24 h) — for search_memory integration
// ============================================================================

export async function getRecentSessionContext(userId, queryEmbedding = null, limit = 3) {
  try {
    const since   = Date.now() - DAILY_DIGEST_CUTOFF_MS;
    const entries = await getSessionSummaries(userId, since, limit * 2);
    if (!entries.length) return [];

    let ranked = entries;
    if (queryEmbedding && entries.some(e => e.embedding?.length)) {
      ranked = entries
        .filter(e => e.embedding?.length)
        .map(e => ({ ...e, score: embeddingService.cosineSimilarity(queryEmbedding, e.embedding) }))
        .sort((a, b) => b.score - a.score);
    }

    return ranked.slice(0, limit).map(e => `[Session Memory — ${_humanAge(e.timestamp)}] ${e.text}`);
  } catch (err) {
    logger.error('getRecentSessionContext failed', err);
    return [];
  }
}

export async function getLatestSessionSummary(userId) {
  try {
    // Redis hot path — check all active historyIds for this user
    const historyIds = await getCollection(COLLECTIONS.SESSION_SUMMARIES)
      .distinct('historyId', { userId, isDailyDigest: false });
    for (const hid of historyIds) {
      const cached = await redisGetSession(`${userId}:${hid}`);
      if (cached) return cached;
    }
    // DB fallback
    const doc = await getCollection(COLLECTIONS.SESSION_SUMMARIES).findOne(
      { userId, isDailyDigest: false },
      { sort: { timestamp: -1 }, projection: { text: 1 } }
    );
    return doc?.text || null;
  } catch { return null; }
}

// ============================================================================
// HELPERS
// ============================================================================

function _humanAge(timestamp) {
  const diffMs = Date.now() - timestamp;
  const h = Math.floor(diffMs / 3_600_000);
  if (h < 1)  return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
