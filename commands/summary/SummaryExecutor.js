/**
 * @fileoverview Summary execution engine — retry/key-rotation logic, file upload helpers,
 *               and the three summarization functions (YouTube, Discord, Website).
 *               No interaction routing lives here; that's in SummaryHandler.js.
 * @module commands/summary/SummaryExecutor
 */

import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder
} from 'discord.js';
import path             from 'path';
import fs               from 'fs/promises';

import {
  genAI,
  TEMP_DIR,
  incrementSummaryUsage,
  switchToNextKey
} from '../../managers/BotManager.js';

import { fetchMessagesForSummary } from '../../utils.js';

import {
  MODELS,
  safetySettings,
  getGenerationConfig,
  RATE_LIMIT_ERRORS,
  DEFAULT_MODEL,
  SYSTEM_AGENT_CALLSIGN
} from '../../modules/config.js';

import { Logger } from '../../core/Logger.js';

const logger = Logger.get('SummaryExecutor');

const ACCENT_COLOR     = 0xE53935;
const IS_COMPONENTS_V2 = 1 << 15;

/**
 * Build a compact Components V2 error container.
 * @param {string} title
 * @param {string} description
 */
function errContainer(title, description) {
  const c = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${title}\n${description}`)
  );
  return c;
}

/**
 * Build a full summary result container.
 * @param {string} emoji
 * @param {string} title
 * @param {string} summaryText
 * @param {Array<{label:string, value:string}>} stats
 * @param {string} [footerNote]
 */
function summaryContainer(emoji, title, summaryText, stats, footerNote) {
  const c = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`## ${emoji}  ${title}`)
  );
  c.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  c.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(summaryText.slice(0, 4000))
  );
  if (stats.length > 0) {
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        stats.map(s => `> ${s.label}   ${s.value}`).join('\n')
      )
    );
  }
  if (footerNote) {
    c.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    c.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${footerNote}`)
    );
  }
  return c;
}

const SUMMARY_MODEL          = DEFAULT_MODEL;
// Summary always uses flash-lite → 3.5-flash, never Gemma:
// summary needs file URI uploads and tool use that Gemma doesn't support.
const SUMMARY_FALLBACK_CHAIN = [
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash'
];
const MAX_RETRY_ATTEMPTS     = 3;
const MAX_UPLOAD_RETRIES     = 3;
const MAX_PROCESSING_WAIT    = 60;   // seconds
const PROCESSING_CHECK_DELAY = 2000; // ms

// ============================================================================
// PUBLIC — SUMMARIZATION ENTRY POINTS (called from SummaryHandler)
// ============================================================================

/**
 * Summarize a YouTube video via Gemini's native video understanding.
 * @param {import('discord.js').CommandInteraction} interaction  Already deferred.
 * @param {string} videoUrl
 */
export async function summarizeYouTubeVideo(interaction, videoUrl) {
  try {
    logger.info(`Summarizing YouTube video: ${videoUrl}`);

    const apiCallFn = async (modelName) => {
      const request = {
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  'Provide a comprehensive, structured summary of this YouTube video. Include:\n' +
                  '• Main topics and key points\n' +
                  '• Important takeaways\n' +
                  '• Notable quotes or moments\n' +
                  'Keep it concise and well-organized with bullet points.'
              },
              { fileData: { fileUri: videoUrl, mimeType: 'video/mp4' } }
            ]
          }
        ],
        config: { ...getGenerationConfig(modelName) },
        safetySettings
      };
      return genAI.models.generateContent(request);
    };

    const response = await executeWithRetry(apiCallFn, SUMMARY_MODEL);
    if (!response.success) throw new Error(response.error ?? 'Failed to generate video summary');

    const summaryText = extractText(response.result);
    if (!summaryText) throw new Error('Gemini returned an empty response');


    incrementSummaryUsage(interaction.user.id);
    await interaction.editReply({
      components: [summaryContainer(
        '📺', 'YouTube Video Summary',
        summaryText,
        [{ label: '🔗  **Source**', value: videoUrl }],
        `Summarized by ${SYSTEM_AGENT_CALLSIGN}`
      )],
      flags: IS_COMPONENTS_V2
    });

  } catch (error) {
    logger.error('YouTube summarization failed', error);
    await interaction.editReply({
      components: [errContainer(
        '❌  Video Summary Failed',
        "I couldn't summarize that video. Please ensure:\n" +
        '> • The video is public and not age-restricted\n' +
        '> • The video has captions or transcripts available\n' +
        `> • The video is not too long (>2 hours)\n\n` +
        `-# Error: ${error.message}`
      )],
      flags: IS_COMPONENTS_V2
    });
  }
}

/**
 * Summarize a Discord conversation fetched from a message link.
 * Writes to a temp file, uploads via Files API, then generates summary.
 * @param {import('discord.js').CommandInteraction} interaction  Already deferred.
 * @param {string} messageLink
 * @param {number} count  Number of messages to include.
 */
export async function summarizeDiscordConversation(interaction, messageLink, count) {
  let filePath = null;

  try {
    logger.info(`Summarizing Discord conversation: ${count} messages`);

    const result = await fetchMessagesForSummary(interaction, messageLink, count);
    if (result.error) {
      return interaction.editReply({
        components: [errContainer('❌  Discord Summary Failed', result.error)],
        flags: IS_COMPONENTS_V2
      });
    }

    if (!result.success || !result.content) {
      throw new Error('Failed to fetch messages');
    }

    // --- Write temp file ---
    const fileName = `discord_summary_${interaction.id}_${Date.now()}.txt`;
    filePath       = path.join(TEMP_DIR, fileName);

    await fs.writeFile(
      filePath,
      `Discord Conversation Summary\n` +
      `Channel: #${result.channelName}\n` +
      `Server: ${result.guildName}\n` +
      `Messages: ${result.messageCount}\n` +
      `${'='.repeat(50)}\n\n` +
      result.content,
      'utf8'
    );

    // --- Upload ---
    const uploadResponse = await uploadFileWithRetry(filePath, {
      mimeType:    'text/plain',
      displayName: 'Discord Conversation Data'
    });
    if (!uploadResponse.success) throw new Error(uploadResponse.error ?? 'File upload failed');

    // --- Wait for processing ---
    const processingResult = await waitForFileProcessing(uploadResponse.result.name);
    if (!processingResult.success) throw new Error(processingResult.error ?? 'File processing failed');

    // mutable URI — updated inside reuploadCallback on key rotation
    let currentFileUri = uploadResponse.result.uri;

    const reuploadCallback = async () => {
      logger.info('Re-uploading Discord conversation file after key rotation');
      const newUpload = await uploadFileWithRetry(filePath, {
        mimeType:    'text/plain',
        displayName: 'Discord Conversation Data'
      });
      if (!newUpload.success) throw new Error('Re-upload failed');
      const newProcessing = await waitForFileProcessing(newUpload.result.name);
      if (!newProcessing.success) throw new Error('Re-uploaded file processing failed');
      currentFileUri = newUpload.result.uri;
    };

    const apiCallFn = async (modelName) => {
      const request = {
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  'Analyze and summarize this Discord conversation. Include:\n' +
                  '• Main topics discussed\n' +
                  '• Key decisions or conclusions\n' +
                  '• Overall tone and mood\n' +
                  '• Notable participants\n' +
                  'Be concise and use bullet points.'
              },
              { fileData: { fileUri: currentFileUri, mimeType: 'text/plain' } }
            ]
          }
        ],
        config: { ...getGenerationConfig(modelName) },
        safetySettings
      };
      return genAI.models.generateContent(request);
    };

    const response = await executeWithRetry(apiCallFn, SUMMARY_MODEL, reuploadCallback);

    // Cleanup regardless of outcome
    await fs.unlink(filePath).catch(() => {});
    filePath = null;

    if (!response.success) throw new Error(response.error ?? 'Failed to generate summary');

    const summaryText = extractText(response.result);
    if (!summaryText) throw new Error('Generated summary was empty');

    incrementSummaryUsage(interaction.user.id);
    await interaction.editReply({
      components: [summaryContainer(
        '💬', 'Discord Conversation Summary',
        summaryText,
        [
          { label: '📍  **Channel**',  value: `#${result.channelName} — ${result.guildName}` },
          { label: '💬  **Messages**', value: String(result.messageCount) }
        ],
        `Summarized by ${SYSTEM_AGENT_CALLSIGN}`
      )],
      flags: IS_COMPONENTS_V2
    });

  } catch (error) {
    logger.error('Discord summarization failed', error);
    if (filePath) await fs.unlink(filePath).catch(() => {});

    await interaction.editReply({
      components: [errContainer(
        '❌  Conversation Summary Failed',
        `Failed to summarize the Discord conversation.\n\n-# Error: ${error.message}`
      )],
      flags: IS_COMPONENTS_V2
    });
  }
}

/**
 * Summarize a website using Gemini's URL context + Google Search tools.
 * @param {import('discord.js').CommandInteraction} interaction  Already deferred.
 * @param {string} websiteUrl
 */
export async function summarizeWebsite(interaction, websiteUrl) {
  try {
    logger.info(`Summarizing website: ${websiteUrl}`);

    const apiCallFn = async (modelName) => {
      const request = {
        model: modelName,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  `Please provide a comprehensive summary of this website: ${websiteUrl}\n\n` +
                  'Include:\n' +
                  '• Main purpose and content\n' +
                  '• Key information and takeaways\n' +
                  '• Important sections or features\n' +
                  'Use bullet points and keep it concise.'
              }
            ]
          }
        ],
        config: {
          ...getGenerationConfig(modelName),
          tools: [{ urlContext: {} }, { googleSearch: {} }]
        },
        safetySettings
      };
      return genAI.models.generateContent(request);
    };

    const response = await executeWithRetry(apiCallFn, SUMMARY_MODEL);
    if (!response.success) throw new Error(response.error ?? 'Failed to generate website summary');

    const summaryText = extractText(response.result);
    if (!summaryText) throw new Error('Generated summary was empty');

    // Optional: surface URL retrieval status
    const urlMeta     = response.result.candidates?.[0]?.url_context_metadata?.url_metadata;
    const urlStatLine = urlMeta?.length > 0
      ? `\n> 🔗  **URL Status**   ${urlMeta[0].url_retrieval_status === 'URL_RETRIEVAL_STATUS_SUCCESS' ? '✅ Retrieved' : '⚠️ ' + urlMeta[0].url_retrieval_status}`
      : '';

    incrementSummaryUsage(interaction.user.id);
    await interaction.editReply({
      components: [summaryContainer(
        '🌐', 'Website Summary',
        summaryText,
        [{ label: '🔗  **Source**', value: websiteUrl + urlStatLine }],
        `Summarized by ${SYSTEM_AGENT_CALLSIGN}`
      )],
      flags: IS_COMPONENTS_V2
    });

  } catch (error) {
    logger.error('Website summarization failed', error);
    await interaction.editReply({
      components: [errContainer(
        '❌  Website Summary Failed',
        "I couldn't summarize that website. Please ensure:\n" +
        '> • The URL is valid and accessible\n' +
        '> • The website is not behind a paywall or login\n' +
        `> • The website allows web scraping\n\n` +
        `-# Error: ${error.message}`
      )],
      flags: IS_COMPONENTS_V2
    });
  }
}

// ============================================================================
// PRIVATE — RETRY ENGINE
// ============================================================================

/**
 * Execute an API call with up to MAX_RETRY_ATTEMPTS attempts.
 * Handles file-permission errors (key-rotation artifacts) via reuploadCallback,
 * rate limits via key rotation + model fallback, and generic errors via backoff.
 *
 * @param {(model: string) => Promise<any>} apiCallFn
 * @param {string}        initialModel
 * @param {Function|null} reuploadCallback  Called when a 403 file error is detected.
 * @returns {Promise<{success: boolean, result?: any, error?: string}>}
 */
async function executeWithRetry(apiCallFn, initialModel, reuploadCallback = null) {
  let attempts           = 0;
  let currentModelIndex  = Math.max(0, SUMMARY_FALLBACK_CHAIN.indexOf(initialModel));
  let currentModel       = SUMMARY_FALLBACK_CHAIN[currentModelIndex];

  while (attempts < MAX_RETRY_ATTEMPTS) {
    try {
      attempts++;
      logger.info(`Summary attempt ${attempts}/${MAX_RETRY_ATTEMPTS} with ${currentModel}`);

      const result = await apiCallFn(currentModel);
      return { success: true, result };

    } catch (error) {
      logger.error(`Summary attempt ${attempts} failed`, error);

      const isFileError =
        (error?.status === 403 || String(error?.message).includes('403')) &&
        /File|file|PERMISSION_DENIED/.test(error?.message);

      if (isFileError && reuploadCallback && attempts < MAX_RETRY_ATTEMPTS) {
        logger.info('File permission error — re-uploading with new key');
        try {
          await reuploadCallback();
          await sleep(1000);
          continue;
        } catch (reuploadError) {
          logger.error('File re-upload failed', reuploadError);
          return { success: false, error: 'File upload failed after key rotation' };
        }
      }

      const isRateLimit = RATE_LIMIT_ERRORS.some(code =>
        String(error?.message).includes(code) || error?.status === code
      );

      if (isRateLimit) {
        logger.info('Rate limit hit — rotating key');
        switchToNextKey(error);
        currentModelIndex++;
        if (currentModelIndex < SUMMARY_FALLBACK_CHAIN.length) {
          currentModel = SUMMARY_FALLBACK_CHAIN[currentModelIndex];
          logger.info(`Falling back to ${currentModel}`);
        }
        await sleep(Math.min(1000 * Math.pow(2, attempts), 8000));
        continue;
      }

      if (attempts < MAX_RETRY_ATTEMPTS) {
        await sleep(1000 * attempts);
        continue;
      }

      return { success: false, error: error.message ?? 'Unknown error after all retries' };
    }
  }

  return { success: false, error: 'Maximum retry attempts exceeded' };
}

// ============================================================================
// PRIVATE — FILE UPLOAD / PROCESSING
// ============================================================================

/**
 * Upload a file to the Gemini Files API with retry + key rotation.
 * @param {string} filePath
 * @param {object} config  `{ mimeType, displayName }`
 * @returns {Promise<{success: boolean, result?: any, error?: string}>}
 */
async function uploadFileWithRetry(filePath, config) {
  let attempts = 0;

  while (attempts < MAX_UPLOAD_RETRIES) {
    try {
      attempts++;
      logger.info(`Upload attempt ${attempts}/${MAX_UPLOAD_RETRIES}`);

      const uploadResult = await genAI.files.upload({ file: filePath, config });
      return { success: true, result: uploadResult };

    } catch (error) {
      logger.error(`Upload attempt ${attempts} failed`, error);

      const isRateLimit = RATE_LIMIT_ERRORS.some(code =>
        String(error?.message).includes(code) || error?.status === code
      );

      if (isRateLimit && attempts < MAX_UPLOAD_RETRIES) {
        switchToNextKey(error);
        await sleep(Math.min(1000 * Math.pow(2, attempts), 8000));
        continue;
      }

      if (attempts >= MAX_UPLOAD_RETRIES) {
        return { success: false, error: error.message ?? 'Upload failed after retries' };
      }

      await sleep(1000);
    }
  }

  return { success: false, error: 'Upload retry loop exited unexpectedly' };
}

/**
 * Poll until a Gemini Files API file reaches ACTIVE state (or fails / times out).
 * @param {string} fileName
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function waitForFileProcessing(fileName) {
  const maxAttempts = Math.ceil(MAX_PROCESSING_WAIT / (PROCESSING_CHECK_DELAY / 1000));
  let attempts      = 0;

  while (attempts < maxAttempts) {
    try {
      const file = await genAI.files.get({ name: fileName });

      if (file.state === 'ACTIVE')  return { success: true };
      if (file.state === 'FAILED')  return { success: false, error: 'File processing failed' };

      attempts++;
      await sleep(PROCESSING_CHECK_DELAY);

    } catch (error) {
      logger.error('Error checking file status', error);
      return { success: false, error: error.message };
    }
  }

  return { success: false, error: 'File processing timeout' };
}

// ============================================================================
// PRIVATE — PURE UTILS
// ============================================================================

/** Extract the first text part from a Gemini GenerateContentResponse. */
function extractText(result) {
  return result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
}

/** Simple promise-based sleep. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
