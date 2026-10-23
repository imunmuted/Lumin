/**
 * @fileoverview /digest command — generate an AI-powered weekly conversation summary.
 *
 * Strategy:
 *   1. Select up to 100 recent text messages from the previous seven days.
 *   2. Upload bounded text to Gemini Files API, then generate a summary.
 *   3. On key-rotation PERMISSION_DENIED, re-upload and retry.
 *
 * @module commands/fun/DigestHandler
 */

import {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder
} from 'discord.js';
import path              from 'path';
import fs                from 'fs/promises';

import { state, saveStateToFile, genAI, TEMP_DIR } from '../../managers/BotManager.js';
import * as db                                      from '../../database/index.js';
import { RATE_LIMIT_ERRORS, MODELS, DEFAULT_MODEL, getSafetySettings } from '../../modules/config.js';
import { Logger }                                   from '../../core/Logger.js';

const logger = Logger.get('DigestHandler');

const FUN_MODEL = MODELS['gemini-3.8-flash'];
const FALLBACK_MODEL = DEFAULT_MODEL;

const COOLDOWN_DAYS          = 7;
const TARGET_TOTAL_MESSAGES  = 100;
const DAYS_TO_ANALYZE        = 7;
const MAX_RETRIES             = 3;
const MAX_UPLOAD_RETRIES      = 3;

const ACCENT_COLOR     = 0xE53935;
const IS_COMPONENTS_V2 = 1 << 15;

// ============================================================================
// COMMAND DEFINITION
// ============================================================================

export const digestCommand = {
  name:        'digest',
  description: 'Get a weekly digest (7-day cooldown, analyzes top ~100 relevant messages)'
};

// ============================================================================
// HANDLER
// ============================================================================

/**
 * Generate and send a weekly digest of conversation history.
 * @param {import('discord.js').CommandInteraction} interaction
 */
export async function handleDigestCommand(interaction) {
  const userId   = interaction.user.id;
  const guildId  = interaction.guild?.id;
  const isDM     = !guildId;
  const now      = Date.now();
  const cooldownMs = COOLDOWN_DAYS * 86_400_000;

  if (!state.userDigests) state.userDigests = {};
  const digestKey  = isDM ? `dm_${userId}` : `server_${guildId}`;
  const lastDigest = state.userDigests[digestKey];

  // --- Cooldown check ---
  if (lastDigest && (now - lastDigest.timestamp) < cooldownMs) {
    const daysLeft = Math.ceil((cooldownMs - (now - lastDigest.timestamp)) / 86_400_000);

    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ⏳  Digest on Cooldown\n` +
        `Your next digest is available in **${daysLeft} day${daysLeft !== 1 ? 's' : ''}**.`
      )
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**📋  Last Digest**\n\n` +
        `> 📅  **Generated**    ${new Date(lastDigest.timestamp).toLocaleString()}\n` +
        `> 💬  **Messages**     ${lastDigest.messageCount}\n` +
        `> 📆  **Days Covered** ${lastDigest.daysAnalyzed}`
      )
    );
    if (lastDigest.summary) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**📝  Summary**\n\n${lastDigest.summary.slice(0, 1000)}`
        )
      );
    }
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# Use /digest again in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`)
    );

    return interaction.reply({ components: [container], flags: IS_COMPONENTS_V2 });
  }

  await interaction.deferReply();

  let filePath = null;

  try {
    const historyId    = isDM ? userId : guildId;
    const sevenDaysAgo = now - DAYS_TO_ANALYZE * 86_400_000;
    let selectedMessages = [];

    // Select recent persisted text history directly. Helium no longer writes
    // embeddings or queries the legacy vector-memory collection for this feature.
    const persistedHistory = await db.getChatHistory(historyId).catch(() => null);
    const currentHistory = state.chatHistories?.[historyId];
    const historyObject = currentHistory && Object.keys(currentHistory).length ? currentHistory : (persistedHistory || {});
    const allRaw = [];
    for (const messages of Object.values(historyObject)) {
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        const timestamp = Number(msg.timestamp || 0);
        if (!timestamp || timestamp < sevenDaysAgo) continue;
        const content = typeof msg.content === 'string' ? msg.content :
          Array.isArray(msg.content) ? msg.content.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join(' ') :
          Array.isArray(msg.parts) ? msg.parts.map(part => typeof part?.text === 'string' ? part.text : '').filter(Boolean).join(' ') : '';
        const text = content.trim();
        if (text) allRaw.push({ ...msg, text, timestamp });
      }
    }
    allRaw.sort((a, b) => a.timestamp - b.timestamp);
    selectedMessages = allRaw.slice(-TARGET_TOTAL_MESSAGES);

    if (selectedMessages.length === 0) {
      const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## 📊  No Recent Activity\n` +
          `No relevant conversations found in the past **${DAYS_TO_ANALYZE} days** to analyze.\n\n` +
          `-# Start chatting and run /digest again next week.`
        )
      );
      return interaction.editReply({ components: [container], flags: IS_COMPONENTS_V2 });
    }

    // --- 3. Build and write the file ---
    const fullText = selectedMessages.map(m => {
      const text = m.text ?? m.content?.map(c => c.text).filter(Boolean).join(' ') ?? '';
      const name = m.displayName ?? m.username ?? 'User';
      const time = new Date(m.timestamp ?? now).toLocaleString();
      return `[${time}] ${name}: ${text}`;
    }).join('\n');

    const fileName = `digest_${digestKey}_${Date.now()}.txt`;
    filePath       = path.join(TEMP_DIR, fileName);

    const fileHeader =
      `${isDM ? 'DM' : 'Server'} Weekly Digest (Source Content)\n` +
      `Generated: ${new Date(now).toLocaleString()}\n` +
      `Period: Last ${DAYS_TO_ANALYZE} days\n` +
      `Messages Analyzed: ${selectedMessages.length} (Target: ${TARGET_TOTAL_MESSAGES})\n\n` +
      '='.repeat(80) + '\n';

    await fs.writeFile(filePath, fileHeader + fullText, 'utf8');

    // --- 4. Upload file with retry ---
    let uploadResult  = null;
    let useInline     = false;

    for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
      try {
        uploadResult = await genAI.files.upload({
          file:   filePath,
          config: { mimeType: 'text/plain', displayName: fileName }
        });
        break;
      } catch (uploadError) {
        logger.error(`Upload attempt ${attempt} failed`, uploadError);

        const isRateLimit = RATE_LIMIT_ERRORS.some(code =>
          uploadError.message?.includes(code) || uploadError.status === code
        );

        if (isRateLimit && attempt < MAX_UPLOAD_RETRIES) {
          await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
          continue;
        }

        if (attempt >= MAX_UPLOAD_RETRIES) {
          logger.error('Upload failed after retries — using inline text');
          useInline = true;
        }
      }
    }

    // --- 5. Build reupload callback for key rotation ---
    const reuploadCallback = !useInline ? async () => {
      logger.info('Re-uploading digest file after key rotation...');
      const result = await genAI.files.upload({
        file:   filePath,
        config: { mimeType: 'text/plain', displayName: fileName }
      });
      return result.uri;
    } : null;

    // --- 6. Generate summary with fallback model ---
    const promptText =
      `Analyze this ${DAYS_TO_ANALYZE}-day conversation log (~${selectedMessages.length} messages) ` +
      `and create a CONCISE executive summary (max 400 words) covering:\n\n` +
      `1. Top 3-5 most discussed topics\n` +
      `2. Key decisions, action items, or conclusions\n` +
      `3. Notable events or funny moments\n` +
      `4. Overall conversation vibe\n` +
      `5. Brief timeline of key activity\n\n` +
      `Be specific but brief. Focus on actionable insights and meaningful highlights.`;

    const buildRequest = (model, fileUri) => ({
      model,
      contents: [{
        role:  'user',
        parts: [
          fileUri
            ? { fileData: { fileUri, mimeType: 'text/plain' } }
            : { text: (fileHeader + fullText).slice(0, 500_000) },
          { text: promptText }
        ]
      }],
      config: {
        systemInstruction: {
          parts: [{ text: 'You are a conversation analyst creating executive summaries. Be concise, specific, and highlight actionable insights. Use bullet points and clear structure.' }]
        },
        temperature:     0.3,
        maxOutputTokens: 1000,
        safetySettings: getSafetySettings(model)
      }
    });

    let aiSummary = 'Unable to generate AI summary.';

    for (const model of [FUN_MODEL, FALLBACK_MODEL]) {
      const request = buildRequest(model, uploadResult?.uri ?? null);
      const result  = await generateWithRetry(request, MAX_RETRIES, reuploadCallback);

      if (result.success) {
        aiSummary = result.result.text?.trim() ?? 'Analysis completed.';
        break;
      }
      logger.error(`Model ${model} failed for digest`, result.error);
    }

    // --- 7. Persist cooldown state ---
    state.userDigests[digestKey] = {
      timestamp:    now,
      messageCount: selectedMessages.length,
      summary:      aiSummary,
      daysAnalyzed: DAYS_TO_ANALYZE
    };
    await saveStateToFile();

    const contextLabel = isDM ? 'DM Digest' : `${interaction.guild?.name}`;
    const nextDigestTs = Math.floor((now + cooldownMs) / 1000);

    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);

    // — Header ——
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## 📊  Weekly Digest\n` +
        `*${contextLabel}  ·  Last ${DAYS_TO_ANALYZE} days*`
      )
    );

    // — Summary ——
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(aiSummary.slice(0, 4000))
    );

    // — Stats ——
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `> 💬  **Messages Analyzed**   ${selectedMessages.length}\n` +
        `> 📆  **Period**              Last ${DAYS_TO_ANALYZE} days\n` +
        `> 🔍  **Selection**           Relevance-ranked\n` +
        `> ⏭️  **Next Digest**         <t:${nextDigestTs}:R>`
      )
    );

    // — Footer ——
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# AI-powered relevance analysis  ·  Vector + chronological selection`
      )
    );

    await interaction.editReply({ components: [container], flags: IS_COMPONENTS_V2 });

  } catch (error) {
    logger.error('Digest generation failed', error);

    const errContainer = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
    errContainer.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `## ❌  Generation Error\n` +
        `Failed to generate your digest. Please try again later.\n\n` +
        `-# ${error.message}`
      )
    );
    await interaction.editReply({ components: [errContainer], flags: IS_COMPONENTS_V2 }).catch(() => {});

  } finally {
    if (filePath) await fs.unlink(filePath).catch(() => {});
  }
}

// ============================================================================
// PRIVATE — AI GENERATION WITH RETRY + RE-UPLOAD
// ============================================================================

/**
 * Call `genAI.models.generateContent` with exponential-backoff retry.
 * Handles both rate-limit errors and key-rotation file-permission errors.
 *
 * @param {object}        request           Gemini generateContent request body.
 * @param {number}        maxRetries
 * @param {Function|null} reuploadCallback  Called on key-rotation error to get a fresh fileUri.
 * @returns {{ success: boolean, result?: object, error?: string }}
 */
async function generateWithRetry(request, maxRetries = 3, reuploadCallback = null) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await genAI.models.generateContent(request);
      return { success: true, result };
    } catch (error) {
      logger.error(`Digest generation attempt ${attempt} failed`, error);

      // Key rotation → stale fileUri → re-upload then retry
      const isFilePermError =
        error.message?.includes('PERMISSION_DENIED') &&
        (error.message?.includes('File') || error.message?.includes('file'));

      if (isFilePermError && reuploadCallback && attempt < maxRetries) {
        try {
          const newUri = await reuploadCallback();
          // Patch the fileData part in-place
          request.contents[0].parts = request.contents[0].parts.map(p =>
            p.fileData ? { fileData: { fileUri: newUri, mimeType: p.fileData.mimeType } } : p
          );
          await new Promise(r => setTimeout(r, 2000));
          continue;
        } catch (reuploadErr) {
          logger.error('Re-upload failed', reuploadErr);
          return { success: false, error: 'File re-upload failed after key rotation' };
        }
      }

      const isRateLimit = RATE_LIMIT_ERRORS.some(code =>
        error.message?.includes(code) || error.status === code
      );

      if (isRateLimit && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
        continue;
      }

      if (attempt >= maxRetries) {
        return { success: false, error: error.message ?? 'Unknown error' };
      }

      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return { success: false, error: 'Failed after maximum retries' };
}
