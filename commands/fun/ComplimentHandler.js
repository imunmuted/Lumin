/**
 * @fileoverview /compliment command — send an anonymous AI-generated compliment via DM (15/day limit).
 * @module commands/fun/ComplimentHandler
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';

import { state, saveStateToFile, genAI } from '../../managers/BotManager.js';
import { memorySystem }                   from '../../memory/MemorySystem.js';
import { MODELS, DEFAULT_MODEL }          from '../../modules/config.js';
import { Logger }                         from '../../core/Logger.js';

const logger = Logger.get('ComplimentHandler');

const FUN_MODEL = MODELS['gemini-3.5-flash-lite'];
const FALLBACK_MODEL         = DEFAULT_MODEL;
const MAX_COMPLIMENTS_PER_DAY = 15;
const ONE_DAY                 = 86_400_000;

const SYSTEM_INSTRUCTION =
  'Generate some compliments. Write in a paragraph (6-7 lines). ' +
  'Be specific, heartfelt, and creative. Avoid generic phrases. Make them personal and meaningful.';

const DEFAULT_COMPLIMENT =
  "You're an amazing person!\nYou bring joy to those around you.\n" +
  "Your positivity is infectious.\nKeep being awesome!";

// ============================================================================
// COMMAND DEFINITION
// ============================================================================

export const complimentCommand = {
  name:        'compliment',
  description: 'Send an anonymous compliment (15 per day limit)',
  options: [
    {
      name:        'user',
      description: 'User to compliment',
      type:        6,
      required:    true
    }
  ]
};

// ============================================================================
// HANDLER
// ============================================================================

/**
 * Generate and anonymously DM a compliment to the target user.
 * @param {import('discord.js').CommandInteraction} interaction
 */
export async function handleComplimentCommand(interaction) {
  const targetUser = interaction.options.getUser('user');
  const senderId   = interaction.user.id;
  const now        = Date.now();

  // --- Guard: no self-compliments ---
  if (targetUser.id === senderId) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Self-Compliment')
      .setDescription("You can't send a compliment to yourself! But I appreciate your confidence! 😊");
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // --- Guard: no bot targets ---
  if (targetUser.bot) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Bot Target')
      .setDescription("Bots don't need compliments (but I appreciate the thought! 🥰)");
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // --- Guard: opt-out ---
  if (!state.complimentOptOut) state.complimentOptOut = {};
  if (state.complimentOptOut[targetUser.id]) {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Opt-Out')
      .setDescription('This user has opted out of receiving compliments.');
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  // --- Rate limit ---
  if (!state.complimentUsage) state.complimentUsage = {};
  const usage = state.complimentUsage[senderId] ??= { count: 0, lastReset: now };

  if (now - usage.lastReset > ONE_DAY) {
    usage.count     = 0;
    usage.lastReset = now;
  }

  if (usage.count >= MAX_COMPLIMENTS_PER_DAY) {
    const hoursLeft = Math.ceil((usage.lastReset + ONE_DAY - now) / 3_600_000);
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Daily Limit Reached')
      .setDescription(
        `You've sent ${MAX_COMPLIMENTS_PER_DAY} compliments today.\n\n` +
        `**Resets in:** ${hoursLeft} hour${hoursLeft > 1 ? 's' : ''}`
      )
      .setFooter({ text: `${usage.count}/${MAX_COMPLIMENTS_PER_DAY} compliments sent today` });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // --- Generate compliment ---
  const compliment = await generateCompliment(targetUser.username);

  // --- Update counters ---
  if (!state.complimentCounts) state.complimentCounts = {};
  state.complimentCounts[targetUser.id] = (state.complimentCounts[targetUser.id] ?? 0) + 1;
  usage.count++;
  await saveStateToFile();

  memorySystem.invalidatePersonalDataCache(targetUser.id);

  const totalReceived = state.complimentCounts[targetUser.id];
  const dmContent =
    `Someone sent you an anonymous compliment ❤️:\n\n${compliment}\n\n` +
    `*You've received ${totalReceived} compliment${totalReceived > 1 ? 's' : ''}!*`;

  // --- Try to DM the target ---
  try {
    await targetUser.send({ content: dmContent });

    const remaining = MAX_COMPLIMENTS_PER_DAY - usage.count;
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Compliment Sent!')
      .setDescription(`Your anonymous compliment has been sent to ${targetUser.username}! 💝`)
      .setFooter({ text: `${remaining} compliment${remaining !== 1 ? 's' : ''} remaining today` });

    await interaction.editReply({ embeds: [embed] });

  } catch {
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ DM Failed')
      .setDescription('Could not send the compliment. The user might have DMs disabled.');
    await interaction.editReply({ embeds: [embed] });
  }
}

// ============================================================================
// PRIVATE — AI GENERATION WITH MODEL FALLBACK
// ============================================================================

/**
 * Generate a compliment for the given username, falling back to DEFAULT_MODEL.
 * @param {string} username
 * @returns {Promise<string>}
 */
async function generateCompliment(username) {
  const buildRequest = model => ({
    model,
    contents: [{
      role:  'user',
      parts: [{ text: `Generate a paragraph (6-7 lines) distinct, sincere, and creative compliments for someone named ${username}` }]
    }],
    config: {
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      temperature: 0.9
    }
  });

  for (const model of [FUN_MODEL, FALLBACK_MODEL]) {
    try {
      const result = await genAI.models.generateContent(buildRequest(model));
      const text   = result.text?.trim();
      if (text) return text;
    } catch (err) {
      logger.error(`generateCompliment failed with model ${model}`, err);
    }
  }

  return DEFAULT_COMPLIMENT;
}
