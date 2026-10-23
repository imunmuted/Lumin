/**
 * @fileoverview /starter command — generate an AI conversation starter (15/day limit).
 * @module commands/fun/StarterHandler
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';

import { state, saveStateToFile, genAI } from '../../managers/BotManager.js';
import { MODELS, DEFAULT_MODEL }          from '../../modules/config.js';
import { Logger }                         from '../../core/Logger.js';

const logger = Logger.get('StarterHandler');

const FUN_MODEL = MODELS['gemini-3.5-flash-lite'];
const FALLBACK_MODEL      = DEFAULT_MODEL;
const MAX_STARTERS_PER_DAY = 15;
const ONE_DAY              = 86_400_000;

const SYSTEM_INSTRUCTION =
  'Generate an interesting conversation starter question. Make it engaging, thought-provoking, and fun. ' +
  'Keep it to one sentence. Vary the topics: philosophy, hypotheticals, preferences, experiences, creativity.';

const DEFAULT_QUESTION = "What's the most interesting thing that happened to you this week?";

// ============================================================================
// COMMAND DEFINITION
// ============================================================================

export const starterCommand = {
  name:        'starter',
  description: 'Get a conversation starter (15 per day limit)'
};

// ============================================================================
// HANDLER
// ============================================================================

/**
 * Generate and send a conversation starter question.
 * @param {import('discord.js').CommandInteraction} interaction
 */
export async function handleStarterCommand(interaction) {
  const userId = interaction.user.id;
  const now    = Date.now();

  if (!state.starterUsage) state.starterUsage = {};

  const usage = state.starterUsage[userId] ??= { count: 0, lastReset: now };

  // Reset window if a day has passed
  if (now - usage.lastReset > ONE_DAY) {
    usage.count     = 0;
    usage.lastReset = now;
  }

  if (usage.count >= MAX_STARTERS_PER_DAY) {
    const hoursLeft = Math.ceil((usage.lastReset + ONE_DAY - now) / 3_600_000);
    const embed = new EmbedBuilder()
      .setColor(0xFF5555)
      .setTitle('❌ Daily Limit Reached')
      .setDescription(
        `You've used all ${MAX_STARTERS_PER_DAY} conversation starters for today.\n\n` +
        `**Resets in:** ${hoursLeft} hour${hoursLeft > 1 ? 's' : ''}`
      )
      .setFooter({ text: `${usage.count}/${MAX_STARTERS_PER_DAY} used today` });
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();

  const question = await generateQuestion();

  usage.count++;
  await saveStateToFile();

  const remaining = MAX_STARTERS_PER_DAY - usage.count;

  const embed = new EmbedBuilder()
    .setColor(0x3498DB)
    .setTitle('💬 Conversation Starter')
    .setDescription(question)
    .setFooter({ text: `${remaining} starter${remaining !== 1 ? 's' : ''} remaining today • Use /starter for more!` });

  await interaction.editReply({ embeds: [embed] });
}

// ============================================================================
// PRIVATE — AI GENERATION WITH MODEL FALLBACK
// ============================================================================

/**
 * Generate a conversation starter, falling back to DEFAULT_MODEL on failure.
 * @returns {Promise<string>}
 */
async function generateQuestion() {
  const buildRequest = model => ({
    model,
    contents: [{ role: 'user', parts: [{ text: 'Generate one unique, engaging conversation starter question.' }] }],
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
      logger.error(`generateQuestion failed with model ${model}`, err);
    }
  }

  return DEFAULT_QUESTION;
}
