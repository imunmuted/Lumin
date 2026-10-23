/**
 * @fileoverview Daily-quote background scheduler — registers per-quote minute-tick
 *               intervals, delivers AI-generated quotes to DM or channel, and
 *               exposes the shared `generateQuote` helper used by QuoteHandler.
 *
 *               No interaction handling lives here; that's in QuoteHandler.js.
 * @module commands/quote/QuoteScheduler
 */

import { EmbedBuilder } from 'discord.js';

import { state, genAI }  from '../../managers/BotManager.js';
import { MODELS, DEFAULT_MODEL } from '../../modules/config.js';
import { getUserTime }           from '../timezone.js';
import { Logger }                from '../../core/Logger.js';

const logger = Logger.get('QuoteScheduler');

const QUOTE_MODEL = MODELS['gemini-3.5-flash-lite'];
const FALLBACK_MODEL = DEFAULT_MODEL;

const FALLBACK_QUOTE = '"The only way to do great work is to love what you do." — Steve Jobs';

// ============================================================================
// PUBLIC
// ============================================================================

/**
 * Register a 60-second tick for one scheduled daily quote.
 * Stores the intervalId on `client.quoteIntervals` (Map).
 *
 * @param {import('discord.js').Client} client
 * @param {string} quoteKey   e.g. `"userId"` or `"userId_2"`
 * @param {object} config     Entry from `state.dailyQuotes[quoteKey]`
 */
export function scheduleDailyQuote(client, quoteKey, config) {
  if (!client.quoteIntervals) client.quoteIntervals = new Map();

  const userId = quoteKey.split('_')[0];

  const intervalId = setInterval(async () => {
    try {
      const userNow = getUserTime(userId);
      if (userNow.getHours() === config.hour && userNow.getMinutes() === config.minute) {
        await sendDailyQuote(client, quoteKey, config);
      }
    } catch (err) {
      logger.error(`Tick error for quote ${quoteKey}`, err);
    }
  }, 60 * 1000);

  client.quoteIntervals.set(quoteKey, intervalId);
}

/**
 * Re-register all active scheduled quotes from state on bot startup.
 * Called once from commands/index.js → initializeScheduledTasks.
 *
 * @param {import('discord.js').Client} client
 */
export function initializeDailyQuotes(client) {
  if (!state.dailyQuotes) return;

  let count = 0;
  for (const quoteKey of Object.keys(state.dailyQuotes)) {
    if (state.dailyQuotes[quoteKey].active) {
      scheduleDailyQuote(client, quoteKey, state.dailyQuotes[quoteKey]);
      count++;
    }
  }

  logger.info(`Quote scheduler started — ${count} active scheduled quote(s) registered`);
}

/**
 * Generate an AI quote for the given category with model fallback.
 * Falls back to a static string if both models fail.
 *
 * @param {string} category  e.g. "inspirational", "funny", "wisdom"
 * @returns {Promise<string>}
 */
export async function generateQuote(category) {
  const systemPrompt =
    `Generate a single ${category} quote. Format: "Quote text" — Author\n\n` +
    `Rules:\n- Keep quotes concise (1–2 sentences)\n- Include author name\n` +
    `- Match the ${category} theme perfectly\n- Be inspiring and meaningful`;

  const buildRequest = model => ({
    model,
    contents: [{ role: 'user', parts: [{ text: `Generate one ${category} quote with author attribution.` }] }],
    config: {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      temperature: 0.9
    }
  });

  for (const model of [QUOTE_MODEL, FALLBACK_MODEL]) {
    try {
      const result = await genAI.models.generateContent(buildRequest(model));
      const text   = result.text?.trim();
      if (text) return text;
    } catch (err) {
      logger.error(`generateQuote failed with model ${model}`, err);
    }
  }

  return FALLBACK_QUOTE;
}

// ============================================================================
// PRIVATE — DELIVERY
// ============================================================================

/**
 * Generate and send one daily quote to the configured destination.
 * @param {import('discord.js').Client} client
 * @param {string} quoteKey
 * @param {object} config
 */
async function sendDailyQuote(client, quoteKey, config) {
  const userId    = quoteKey.split('_')[0];
  const category  = config.category ?? 'inspirational';
  const label     = category.charAt(0).toUpperCase() + category.slice(1);
  const quote     = await generateQuote(category);

  const embed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`✨ Your Daily ${label} Quote`)
    .setDescription(quote)
    .setFooter({ text: "Scheduled quote • Doesn't count toward your 5/day limit" })
    .setTimestamp();

  if (config.location === 'dm') {
    const user = await client.users.fetch(userId).catch(() => null);
    if (user) {
      await user.send({ embeds: [embed] }).catch(err =>
        logger.error(`Daily quote DM failed for user ${userId}`, err)
      );
    }
  } else if (config.location === 'server' && config.channelId) {
    const channel = client.channels.cache.get(config.channelId);
    if (channel) {
      await channel.send({ embeds: [embed] }).catch(err =>
        logger.error(`Daily quote channel send failed for channel ${config.channelId}`, err)
      );
    }
  }
}
