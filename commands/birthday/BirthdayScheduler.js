/**
 * @fileoverview Birthday background scheduler — checks birthdays hourly and sends AI-generated wishes.
 *               No interaction handling lives here; that's in BirthdayHandler.js.
 * @module commands/birthday/BirthdayScheduler
 */

import { EmbedBuilder } from 'discord.js';

import { state, saveStateToFile, genAI } from '../../managers/BotManager.js';
import * as db                            from '../../database/index.js';
import { MODELS, DEFAULT_MODEL }          from '../../modules/config.js';
import { getUserTime }                    from '../timezone.js';
import { Logger }                         from '../../core/Logger.js';

const logger = Logger.get('BirthdayScheduler');

const BIRTHDAY_MODEL = MODELS['gemini-3.5-flash-lite'];
const FALLBACK_MODEL     = DEFAULT_MODEL;
const WISH_DELAY_MS      = 2000;
const CHECK_INTERVAL_MS  = 60 * 60 * 1000;   // hourly
const STARTUP_DELAY_MS   = 5000;              // 5 s after boot

// ============================================================================
// PUBLIC — called once at startup from commands/index.js
// ============================================================================

/**
 * Register the birthday check interval and run an initial check 5 s after startup.
 * @param {import('discord.js').Client} client
 */
export function scheduleBirthdayChecks(client) {
  setInterval(() => checkBirthdays(client), CHECK_INTERVAL_MS);
  setTimeout(() => checkBirthdays(client), STARTUP_DELAY_MS);
  logger.info('Birthday scheduler started');
}

// ============================================================================
// PRIVATE — SCHEDULER
// ============================================================================

/**
 * Scan all birthday entries and send wishes for any that match today's date
 * in the user's local timezone (and haven't already been wished this year).
 * @param {import('discord.js').Client} client
 */
async function checkBirthdays(client) {
  if (!state.birthdays) return;

  for (const [key, data] of Object.entries(state.birthdays ?? {})) {
    try {
      const userId  = key.split('_')[0];
      const userNow = getUserTime(userId);

      const month = String(userNow.getMonth() + 1).padStart(2, '0');
      const day   = String(userNow.getDate()).padStart(2, '0');

      if (data.month !== month || data.day !== day) continue;

      const currentYear = userNow.getFullYear();
      if (data.year === currentYear) continue;   // already wished this year

      // Rate-limit between wishes to avoid hammering the API
      await new Promise(r => setTimeout(r, WISH_DELAY_MS));

      await sendBirthdayWish(client, userId, data);

      state.birthdays[key].year = currentYear;
      await db.saveBirthday(key, state.birthdays[key]);
      await saveStateToFile();

    } catch (error) {
      logger.error(`Birthday check failed for key ${key}`, error);
    }
  }
}

// ============================================================================
// PRIVATE — WISH SENDER
// ============================================================================

/**
 * Generate an AI birthday wish and deliver it via DM and/or server channel
 * according to the user's stored preference.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {object} data  Birthday entry from state.birthdays.
 */
async function sendBirthdayWish(client, userId, data) {
  const user = await client.users.fetch(userId).catch(() => null);
  if (!user) return;

  const personName = data.nameType === 'self' ? user.username : 'someone special';
  const wishText   = await generateWish(personName);

  const embed = new EmbedBuilder()
    .setColor(0xFF69B4)
    .setTitle('🎉 Happy Birthday! 🎂')
    .setDescription(wishText)
    .setThumbnail(user.displayAvatarURL())
    .setFooter({ text: '🎊 Hope your day is as special as you are!' })
    .setTimestamp();

  // --- DM ---
  if (data.preference === 'dm' || data.preference === 'both') {
    await user.send({ embeds: [embed] }).catch(err =>
      logger.error(`Birthday DM failed for user ${userId}`, err)
    );
  }

  // --- Server ---
  if ((data.preference === 'server' || data.preference === 'both') && data.guildId) {
    try {
      const guild   = client.guilds.cache.get(data.guildId);
      if (!guild) return;

      const channel = guild.channels.cache.find(ch =>
        ch.isTextBased() &&
        guild.members.me &&
        ch.permissionsFor(guild.members.me)?.has('SendMessages')
      );

      if (channel) {
        const mention = data.nameType === 'self' ? `<@${userId}>` : user.username;
        await channel.send({
          content: `🎉 Everyone! It's ${mention}'s birthday today! 🎂`,
          embeds:  [embed]
        });
      }
    } catch (err) {
      logger.error(`Birthday server message failed for guild ${data.guildId}`, err);
    }
  }
}

// ============================================================================
// PRIVATE — AI GENERATION WITH MODEL FALLBACK
// ============================================================================

/**
 * Generate a short personalised birthday wish.
 * Falls back to DEFAULT_MODEL then to a static string on complete failure.
 * @param {string} personName
 * @returns {Promise<string>}
 */
async function generateWish(personName) {
  const buildRequest = model => ({
    model,
    contents: [{ role: 'user', parts: [{ text: `Write a birthday wish for ${personName}` }] }],
    config: {
      systemInstruction: {
        parts: [{ text: 'Generate a short, warm, and personalized birthday wish (2-3 sentences). Be genuine and heartfelt. Include emojis.' }]
      },
      temperature: 0.9
    }
  });

  for (const model of [BIRTHDAY_MODEL, FALLBACK_MODEL]) {
    try {
      const result = await genAI.models.generateContent(buildRequest(model));
      const text   = result.text?.trim();
      if (text) return text;
    } catch (err) {
      logger.error(`generateWish failed with model ${model}`, err);
    }
  }

  return `Happy Birthday, ${personName}! 🎂🎉 Wishing you an amazing day filled with joy!`;
}
