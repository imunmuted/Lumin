/**
 * @fileoverview Weekly User Context Summary System.
 *
 * Runs as a background cron-style process every Sunday at 02:00 UTC.
 * Compiles a structured, pronoun-free user summary from stored facts and
 * recent memory entries. The summary is injected into the agent's system prompt
 * as persistent baseline knowledge — meaning the agent never needs to burn RAG
 * calls just to know basic facts about who it is talking to.
 *
 * Formatting rules (strict):
 *   - No first-person (I/my/me) or second-person (you/your) pronouns.
 *   - Refer exclusively to "the user" or neutral phrasing.
 *   - Verbatim quotes preserved where available.
 *   - Each entry: The user's [attribute] is [value].
 *     Evidence: User said '[quote]'. Date: [YYYY-MM-DD].
 *
 * Output categories (fixed order):
 *   1. Demographics
 *   2. Interests and preferences
 *   3. Relationships
 *   4. Dated events, projects and plans
 *   5. Instructions (sourced exclusively from stored facts/memories)
 *
 * Storage: MongoDB `weeklySummaries` collection + Redis cache (7-day TTL).
 * Injection: Prepended to system instruction in MessageProcessor.
 *
 * @module commands/summary/WeeklySummaryJob
 */

import { Logger }                from '../../core/Logger.js';
import * as db                   from '../../database/index.js';
import { genAI }                 from '../../managers/BotManager.js';
import { redisCache }            from '../../memory/RedisCache.js';
import { getCollection, COLLECTIONS } from '../../database/connection.js';

const logger = Logger.get('WeeklySummaryJob');

// ============================================================================
// CONSTANTS
// ============================================================================

const SUMMARY_MODEL          = 'gemini-3.5-flash-lite';
const REDIS_SUMMARY_TTL      = 7 * 24 * 60 * 60;   // 7 days in seconds
const REDIS_KEY_PREFIX       = 'helium:weekly:';
const MAX_FACTS_PER_USER     = 30;
const MAX_MEMORY_ENTRIES     = 15;

// ============================================================================
// FORMATTING PROMPT
// ============================================================================

const SUMMARY_SYSTEM_PROMPT = `You are a memory compiler for an AI assistant. Your task is to analyze stored facts and conversation snippets about a user, then produce a structured, factual summary.

STRICT RULES — violate none:
- ZERO first-person pronouns (I, my, me, mine, we, our).
- ZERO second-person pronouns (you, your, yours).
- Refer to the person exclusively as "the user" or neutral phrasing.
- Preserve verbatim quotes where provided. Do not paraphrase the user's own words.
- Each entry must follow EXACTLY this syntax:
    The user's [attribute] is [value].
    Evidence: User said '[exact quote if available]'. Date: [YYYY-MM-DD or 'unknown'].
- If there is no evidence for a category, write: No confirmed data for this category.
- Do not invent or infer facts not supported by the provided data.
- Do not include instructions sourced from general conversation — instructions must come only from explicit stored facts/memories.

OUTPUT FORMAT (use these exact headers, in this exact order):

## 1. Demographics
[Preferred name, profession, education, general residence]

## 2. Interests and Preferences
[Sustained, active engagements only — exclude one-time purchases or passing mentions]

## 3. Relationships
[Confirmed, sustained relationships — family, friends, partners only if clearly established]

## 4. Dated Events, Projects and Plans
[Significant recent activities with dates where known]

## 5. Instructions
[Explicit behavioral rules: 'always do X', 'never do Y', corrections. Sourced from stored facts/memories only — not general chat.]`;

// ============================================================================
// REDIS HELPERS (extend RedisCache for weekly summaries with custom TTL)
// ============================================================================

async function redisSaveSummary(userId, summaryText) {
  try {
    await redisCache.rawSet(`${REDIS_KEY_PREFIX}${userId}`, summaryText, REDIS_SUMMARY_TTL);
  } catch { /* non-fatal */ }
}

async function redisGetSummary(userId) {
  try {
    return await redisCache.rawGet(`${REDIS_KEY_PREFIX}${userId}`);
  } catch { return null; }
}

// ============================================================================
// MONGODB HELPERS
// ============================================================================

async function saveSummaryToDB(userId, summaryText) {
  try {
    await getCollection(COLLECTIONS.WEEKLY_SUMMARIES).updateOne(
      { userId },
      {
        $set: {
          userId,
          summary:     summaryText,
          generatedAt: new Date(),
          weekOf:      _weekLabel()
        }
      },
      { upsert: true }
    );
  } catch (err) {
    logger.error(`Failed to save weekly summary for ${userId}`, err);
  }
}

async function getSummaryFromDB(userId) {
  try {
    const doc = await getCollection(COLLECTIONS.WEEKLY_SUMMARIES).findOne(
      { userId },
      { projection: { summary: 1, generatedAt: 1 } }
    );
    return doc?.summary || null;
  } catch { return null; }
}

/**
 * L-18 fix: compute the correct ISO 8601 week number.
 * The old Math.ceil(day/7) formula was wrong (it gives 1–5, not 1–53,
 * and snaps at month boundaries rather than real weeks).
 * @returns {string} e.g. "2025-W21"
 */
function _weekLabel() {
  const d = new Date();
  // ISO week: Thursday of the current week must be in the given year.
  // Algorithm from https://www.epochconverter.com/weeknumbers
  const dayOfWeek = d.getUTCDay() || 7; // 1=Mon … 7=Sun
  const thursday  = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 4 - dayOfWeek); // the Thursday of this week
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo    = Math.ceil(((thursday - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ============================================================================
// SUMMARY GENERATION
// ============================================================================

/**
 * Generate the weekly summary for a single user.
 *
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
async function generateSummaryForUser(userId) {
  try {
    // 1. Gather stored facts
    const facts = await db.getUserFacts(userId);
    if (!facts || facts.length === 0) return null;

    // 2. Gather recent memory text snippets (lean — text field only)
    const memoryEntries = await getCollection(COLLECTIONS.MEMORY_ENTRIES)
      .find(
        { 'metadata.userId': userId },
        { projection: { text: 1, timestamp: 1 } }
      )
      .sort({ timestamp: -1 })
      .limit(MAX_MEMORY_ENTRIES)
      .toArray();

    // 3. Build input payload for the model
    const factsBlock = facts.slice(0, MAX_FACTS_PER_USER)
      .map((f, i) => `FACT ${i + 1}: ${f}`)
      .join('\n');

    const memoryBlock = memoryEntries
      .map(e => {
        const date = e.timestamp
          ? new Date(e.timestamp).toISOString().slice(0, 10)
          : 'unknown';
        return `[${date}] ${e.text || ''}`;
      })
      .filter(s => s.length > 12)
      .join('\n');

    const userContent = [
      `STORED FACTS:\n${factsBlock}`,
      memoryBlock ? `\nRECENT CONVERSATION SNIPPETS:\n${memoryBlock}` : ''
    ].join('').trim();

    if (!userContent) return null;

    // 4. Call Gemini
    const result = await genAI.models.generateContent({
      model: SUMMARY_MODEL,
      contents: [{ role: 'user', parts: [{ text: userContent }] }],
      config: {
        systemInstruction: SUMMARY_SYSTEM_PROMPT,
        temperature: 0.1,   // Low temp: factual, not creative
        maxOutputTokens: 800
      }
    });

    return result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;

  } catch (err) {
    logger.error(`Summary generation failed for user ${userId}`, err);
    return null;
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Get the weekly summary for a user — checks Redis → MongoDB → generate.
 * Returns null if no data exists yet.
 *
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function getWeeklySummary(userId) {
  // L1: Redis (~1ms)
  const cached = await redisGetSummary(userId);
  if (cached) return cached;

  // L2: MongoDB
  const stored = await getSummaryFromDB(userId);
  if (stored) {
    redisSaveSummary(userId, stored).catch(() => {});
    return stored;
  }

  return null;
}

/**
 * Force-regenerate the weekly summary for a single user immediately.
 * Used by the cron job and can be called manually for testing.
 *
 * @param {string} userId
 * @returns {Promise<boolean>} true on success
 */
export async function regenerateSummaryForUser(userId) {
  const summary = await generateSummaryForUser(userId);
  if (!summary) return false;

  await saveSummaryToDB(userId, summary);
  await redisSaveSummary(userId, summary);
  logger.info(`Weekly summary regenerated for user ${userId}`);
  return true;
}

/**
 * Run the full weekly job — finds all users with stored facts and
 * regenerates their summaries. Processes users in parallel batches
 * sized to the number of loaded API keys (30 keys = 30 parallel users)
 * so we saturate available quota without exceeding it.
 *
 * @returns {Promise<void>}
 */
export async function runWeeklySummaryJob() {
  logger.info('Weekly summary job starting…');

  try {
    // L-8 fix: only process users active in the last 7 days (current week).
    const ACTIVITY_CUTOFF_MS = 7 * 24 * 60 * 60 * 1_000;
    const cutoffDate = new Date(Date.now() - ACTIVITY_CUTOFF_MS);

    // Get users that have BOTH stored facts AND a recent memory entry
    const activeUserIds = await getCollection(COLLECTIONS.MEMORY_ENTRIES)
      .distinct('metadata.userId', {
        'metadata.userId': { $exists: true, $ne: null },
        timestamp: { $gte: cutoffDate.getTime() }
      });

    // Intersect with users who actually have facts (no point summarising if no facts)
    const allFactUserIds = new Set(
      await getCollection(COLLECTIONS.USER_FACTS).distinct('userId')
    );
    const eligibleIds = activeUserIds.filter(id => allFactUserIds.has(id));

    if (!eligibleIds.length) {
      logger.info('Weekly summary job: no active users with facts found');
      return;
    }

    // Week-freshness dedup: skip users who already have a summary for this week.
    // Prevents duplicate generation if the bot restarts mid-week or the job is
    // somehow triggered more than once in the same week.
    const currentWeek = _weekLabel();
    const alreadyDoneThisWeek = new Set(
      (await getCollection(COLLECTIONS.WEEKLY_SUMMARIES)
        .find({ weekOf: currentWeek }, { projection: { userId: 1, _id: 0 } })
        .toArray()
      ).map(d => d.userId)
    );

    const userIds = eligibleIds.filter(id => !alreadyDoneThisWeek.has(id));

    if (!userIds.length) {
      logger.info('Weekly summary job: all active users already have a fresh summary for this week');
      return;
    }

    // Batch size = number of API keys so we saturate quota without exceeding it
    const { getApiKeyCount } = await import('../../managers/ApiKeyManager.js');
    const batchSize = Math.max(1, getApiKeyCount());

    logger.info(`Weekly summary job: ${userIds.length} users to process (${alreadyDoneThisWeek.size} already done this week), batch size ${batchSize}`);

    let successCount = 0;
    let failCount    = 0;

    // Slice into batches and process each batch in parallel
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(userId => regenerateSummaryForUser(userId))
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) successCount++;
        else failCount++;
      }

      // 2-second pause between batches — avoids per-minute RPM cap
      if (i + batchSize < userIds.length) {
        await new Promise(r => setTimeout(r, 2_000));
      }
    }

    logger.info(`Weekly summary job complete. Success: ${successCount}, Failed: ${failCount}`);

  } catch (err) {
    logger.error('Weekly summary job crashed', err);
  }
}

/**
 * Schedule the weekly job to run every Sunday at 02:00 UTC.
 * Self-rescheduling — call once at startup.
 *
 * @returns {void}
 */
export function scheduleWeeklySummaryJob() {
  const msUntilNextRun = _msUntilNextSunday2AM();
  logger.info(`Weekly summary job scheduled in ${Math.round(msUntilNextRun / 3600000)}h`);

  setTimeout(async () => {
    await runWeeklySummaryJob();
    scheduleWeeklySummaryJob(); // reschedule
  }, msUntilNextRun);
}

function _msUntilNextSunday2AM() {
  const now = new Date();

  // Build a candidate: today at 02:00 UTC
  const candidate = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0, 0
  ));

  // If today IS Sunday and 02:00 UTC hasn't passed yet — run later today.
  // (The original code always added 7 days on Sunday, missing the same-day slot.)
  if (now.getUTCDay() === 0 && now.getTime() < candidate.getTime()) {
    return Math.max(candidate.getTime() - now.getTime(), 60_000);
  }

  // Otherwise advance to the NEXT Sunday at 02:00 UTC.
  const daysUntilNextSunday = (7 - now.getUTCDay()) % 7 || 7;
  candidate.setUTCDate(candidate.getUTCDate() + daysUntilNextSunday);
  return Math.max(candidate.getTime() - now.getTime(), 60_000); // min 1 min
}
