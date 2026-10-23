/**
 * @fileoverview Streaming response handler — typing indicator, generation loop,
 *               model fallback, function calling, and history persistence.
 * @module modules/message/ResponseHandler
 */

import { EmbedBuilder } from 'discord.js';
import path              from 'path';
import fs                from 'fs/promises';

import {
  genAI,
  state,
  BOT_CONFIG,
  DEFAULT_USER_SETTINGS,
  getDefaultUserSettings,
  TEMP_DIR,
  switchToNextKey,
  switchToNextKeyOrModel
} from '../../managers/BotManager.js';
import { Logger }  from '../../core/Logger.js';
import { Embeds, addGroundingFields, addUrlContextFields, GOOGLE_AI_ICON } from '../shared/embedBuilder.js';
import { executeFunctionCalls }         from '../functions/FunctionExecutor.js';
import {
  consumePendingSticker, clearPendingSticker,
  consumePendingGif,     clearPendingGif,
  setLastBotMessage
} from '../functions/pendingMedia.js';
import { getGenerationConfig, getSafetySettings, RATE_LIMIT_ERRORS, MODEL_FALLBACK_CHAIN, isGemmaModel, getModelMetadata } from '../../modules/config.js';
import { getRuntimeFeatureFlag } from '../../helium/runtimeRegistry.js';
import { extractFileText }              from './PromptBuilder.js';
import { processPromptAndMediaAttachments, classifyAttachments } from './MediaHandler.js';
import { saveMessageHistory }           from './HistoryManager.js';
import { addDownloadButton, addDeleteButton } from '../shared/buttonHandlers.js';

const logger = Logger.get('ResponseHandler');

// ============================================================================
// SLEEP HELPER  (replaces `delay` from tools/others.js)
// ============================================================================

/** @param {number} ms @returns {Promise<void>} */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// ABSORBED FROM OLD ROOT responseHandler.js
// (updateEmbed / updateEmbedForInteraction / sendAsTextFile)
// All console.* replaced with logger; grounding builders use shared embedBuilder.
// ============================================================================

const EMBED_DESCRIPTION_MAX = 4096;

/**
 * Update a bot message in-place with a formatted embed containing the AI
 * response. Called both mid-stream (debounced) and at stream completion.
 *
 * @param {import('discord.js').Message} botMessage
 * @param {string}      finalResponse
 * @param {import('discord.js').Message} originalMessage
 * @param {object|null} groundingMetadata
 * @param {object|null} urlContextMetadata
 * @param {object}      effectiveSettings
 */
export function updateEmbed(
  botMessage,
  finalResponse,
  originalMessage,
  groundingMetadata,
  urlContextMetadata,
  effectiveSettings
) {
  try {
    const embedColor      = effectiveSettings.embedColor || BOT_CONFIG.HEX_COLOUR;
    const continuousReply = effectiveSettings.continuousReply ?? getDefaultUserSettings().continuousReply;
    const showMetadata    = effectiveSettings.responseFormat === 'Embedded';
    const isGuild         = originalMessage.guild !== null;

    // M-5 fix: append truncation notice instead of silently cutting off
    let embedDescription;
    if (finalResponse.length > EMBED_DESCRIPTION_MAX) {
      const truncateAt = EMBED_DESCRIPTION_MAX - 80;
      embedDescription = finalResponse.slice(0, truncateAt) +
        `\n\n*[Response truncated — ${finalResponse.length} chars total. Use /summary for long context.]*`;
    } else {
      embedDescription = finalResponse;
    }

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setDescription(embedDescription)
      .setTimestamp();

    if (!continuousReply) {
      embed.setAuthor({
        name:    `To ${originalMessage.author.displayName}`,
        iconURL: originalMessage.author.displayAvatarURL()
      });
    }

    if (groundingMetadata  && showMetadata) addGroundingFields(embed, groundingMetadata);
    if (urlContextMetadata && showMetadata) addUrlContextFields(embed, urlContextMetadata);

    if (isGuild) {
      embed.setFooter({
        text:    originalMessage.guild.name,
        iconURL: originalMessage.guild.iconURL() || GOOGLE_AI_ICON
      });
    }

    botMessage.edit({ content: ' ', embeds: [embed], components: [] }).catch(() => {});
  } catch (error) {
    logger.error('Error updating embed', error);
  }
}

/**
 * Edit an interaction reply with a formatted embed.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {import('discord.js').Message}     botMessage
 * @param {string}      finalResponse
 * @param {object|null} groundingMetadata
 * @param {object|null} urlContextMetadata
 * @param {object}      effectiveSettings
 */
export function updateEmbedForInteraction(
  interaction,
  botMessage,
  finalResponse,
  groundingMetadata,
  urlContextMetadata,
  effectiveSettings
) {
  try {
    const embedColor   = effectiveSettings.embedColor || BOT_CONFIG.HEX_COLOUR;
    const showMetadata = effectiveSettings.responseFormat === 'Embedded';
    const isGuild      = interaction.guild !== null;

    // M-5 fix: append truncation notice instead of silently cutting off
    let interactionDesc;
    if (finalResponse.length > EMBED_DESCRIPTION_MAX) {
      const truncateAt = EMBED_DESCRIPTION_MAX - 80;
      interactionDesc = finalResponse.slice(0, truncateAt) +
        `\n\n*[Response truncated — ${finalResponse.length} chars total. Use /summary for long context.]*`;
    } else {
      interactionDesc = finalResponse;
    }

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setDescription(interactionDesc)
      .setTimestamp()
      .setAuthor({
        name:    `To ${interaction.user.displayName}`,
        iconURL: interaction.user.displayAvatarURL()
      });

    if (groundingMetadata  && showMetadata) addGroundingFields(embed, groundingMetadata);
    if (urlContextMetadata && showMetadata) addUrlContextFields(embed, urlContextMetadata);

    if (isGuild) {
      embed.setFooter({
        text:    interaction.guild.name,
        iconURL: interaction.guild.iconURL() || GOOGLE_AI_ICON
      });
    }

    interaction.editReply({ content: ' ', embeds: [embed] }).catch(() => {});
  } catch (error) {
    logger.error('Error updating interaction embed', error);
  }
}

/**
 * Write `text` to a temp file and send/edit it as a Discord attachment.
 * Handles both Message-based and Interaction-based contexts.
 *
 * @param {string}  text
 * @param {import('discord.js').Message|import('discord.js').Interaction} messageOrInteraction
 * @param {string}  orgId            - ID of an existing bot message to edit (message path)
 * @param {boolean} [continuousReply=false]
 * @returns {Promise<import('discord.js').Message|null>}
 */
export async function sendAsTextFile(text, messageOrInteraction, orgId, continuousReply = false) {
  const tempFilePath = path.join(TEMP_DIR, `response-${Date.now()}.txt`);
  try {
    await fs.writeFile(tempFilePath, text);

    const userId  = messageOrInteraction.user?.id || messageOrInteraction.author?.id;
    const channel = messageOrInteraction.channel;
    if (!userId || !channel) throw new Error('Could not determine user or channel.');

    const isInteraction = !!messageOrInteraction.isInteraction;
    const mention       = (isInteraction || !continuousReply) ? `<@${userId}>, ` : '';
    const content       = `${mention}Here is the response:`;

    let botMessage;
    if (isInteraction) {
      botMessage = await messageOrInteraction.editReply({
        content, files: [tempFilePath], embeds: [], components: []
      });
    } else {
      const toEdit = await channel.messages.fetch(orgId).catch(() => null);
      if (toEdit) {
        botMessage = await toEdit.edit({ content, files: [tempFilePath], embeds: [], components: [] });
      } else {
        botMessage = await channel.send({ content, files: [tempFilePath] });
      }
    }

    await fs.unlink(tempFilePath).catch(() => {});
    return botMessage;
  } catch (error) {
    logger.error('Error sending as text file', error);
    await fs.unlink(tempFilePath).catch(() => {});
    return null;
  }
}

// ============================================================================
// CONSTANTS
// ============================================================================

const TYPING_INTERVAL_MS = 4_000;
const TYPING_TIMEOUT_MS  = 120_000;
const CHAR_THRESHOLD     = 150;          // chars before initial message is sent
const UPDATE_DEBOUNCE_MS = 350;          // min ms between stream edits

const MAX_RETRY_ATTEMPTS      = 3;
const MAX_FUNCTION_CALL_TURNS = 5;

const CHARACTER_LIMITS = Object.freeze({
  EMBEDDED:    3900,
  NORMAL:      1900,
  DISCORD_MAX: 2000
});

const RETRY_DELAYS = Object.freeze({
  DEFAULT:    1500,
  RATE_LIMIT: 2000,
  FILE_ERROR: 1000
});

// ============================================================================
// TYPING MANAGER
// ============================================================================

class TypingManager {
  constructor() {
    /** @type {Map<string, ReturnType<typeof setInterval>>} */
    this.activeIntervals = new Map();
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.cleanupTimers   = new Map();
  }

  /** Start a typing indicator on a channel (no-op if already running). */
  start(channel) {
    if (!channel || this.activeIntervals.has(channel.id)) return;
    this._clearCleanup(channel.id);

    channel.sendTyping().catch(() => {});
    const intervalId = setInterval(() => channel.sendTyping().catch(() => {}), TYPING_INTERVAL_MS);
    this.activeIntervals.set(channel.id, intervalId);

    const timer = setTimeout(() => this.stop(channel.id), TYPING_TIMEOUT_MS);
    this.cleanupTimers.set(channel.id, timer);
  }

  /** Stop the typing indicator for a channel. */
  stop(channelId) {
    const id = this.activeIntervals.get(channelId);
    if (id !== undefined) { clearInterval(id); this.activeIntervals.delete(channelId); }
    this._clearCleanup(channelId);
  }

  /** Stop ALL typing indicators (e.g. on shutdown). */
  stopAll() {
    for (const id of this.activeIntervals.values()) clearInterval(id);
    for (const t  of this.cleanupTimers.values())   clearTimeout(t);
    this.activeIntervals.clear();
    this.cleanupTimers.clear();
  }

  _clearCleanup(channelId) {
    const t = this.cleanupTimers.get(channelId);
    if (t !== undefined) { clearTimeout(t); this.cleanupTimers.delete(channelId); }
  }
}

/** Shared singleton — imported by MessageProcessor for start/stop calls. */
export const typingManager = new TypingManager();

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Strip fileUri / fileData parts from history entries, replacing them with
 * text stubs so expired Gemini file references don't cause 403 errors.
 * @param {object[]} history
 * @returns {object[]}
 */
export function cleanHistoryFiles(history) {
  return history
    .map(entry => ({
      role:  entry.role,
      parts: (entry.parts || entry.content || [])
        .map(p => (p.fileUri || p.fileData) ? { text: '[Previous file attachment - content no longer available]' } : p)
        .filter(p => p.text)
    }))
    .filter(entry => entry.parts.length > 0);
}

function isFileError(error) {
  const is403    = error?.status === 403 || error?.code === 403 || error?.message?.includes('403');
  const keywords = error?.message?.includes('File') ||
                   error?.message?.includes('file') ||
                   error?.message?.includes('PERMISSION_DENIED');
  return is403 && keywords;
}

function isRateLimitError(error) {
  return RATE_LIMIT_ERRORS.some(code =>
    error?.message?.includes(code) ||
    error?.status  === code        ||
    error?.code?.includes?.(code)
  );
}

/**
 * Extract all text output from a single stream chunk, including code execution blocks.
 * @param {object} chunk
 * @param {string} [modelName]
 * @returns {string}
 */
function extractChunkText(chunk, modelName = '') {
  // Use raw parts to exclude thought parts (thought: true) which are internal
  // reasoning that must NOT be sent to Discord. chunk.text is a SDK convenience
  // accessor that concatenates ALL text parts including thoughts — avoid it.
  const rawParts = chunk.candidates?.[0]?.content?.parts ?? [];
  let text = rawParts.length
    ? rawParts.filter(p => !p.thought).map(p => p.text || '').join('')
    : (chunk.text || '');

  if (!isGemmaModel(modelName)) {
    if (chunk.executableCode?.code) {
      const lang = (chunk.executableCode.language || 'python').toLowerCase();
      text += `\n**Generated Code (${lang}):**\n\`\`\`${lang}\n${chunk.executableCode.code}\n\`\`\`\n`;
    }

    if (chunk.codeExecutionResult?.output) {
      const outcome = chunk.codeExecutionResult.outcome || 'UNKNOWN';
      text += `\n**Code Execution (${outcome}):**\n\`\`\`\n${chunk.codeExecutionResult.output}\n\`\`\`\n`;
    }
  }

  return text;
}

// ============================================================================
// MAIN GENERATION HANDLER
// ============================================================================

/**
 * Run the full AI generation cycle: stream response, handle retries and model
 * fallback, execute function calls, send/edit the Discord message, and persist
 * the conversation turn.
 *
 * NOTE: `baseGenerationConfig` has been removed — it was always `null` in every
 * call site. `getGenerationConfig(modelName)` is used directly instead.
 *
 * @param {import('discord.js').Message|null} initialBotMessage - Existing reply to update, or null
 * @param {string}   modelName
 * @param {string}   systemInstruction
 * @param {object}   safetySettings
 * @param {object[]} tools
 * @param {object[]} history             - Optimised history from memorySystem
 * @param {object[]} parts               - Gemini content parts for this turn
 * @param {import('discord.js').Message} originalMessage
 * @param {string}   channelId
 * @param {string}   historyId
 * @param {object}   effectiveSettings
 * @param {string}   [originalPrompt]    - Raw prompt text for re-preparation on key rotation
 * @param {object[]} [allAttachments]    - All attachment objects for re-preparation
 * @param {object[]|null} [preparedMessages] - Non-null for batched turns
 * @returns {Promise<void>}
 */
export async function handleModelResponse(
  initialBotMessage,
  modelName,
  systemInstruction,
  safetySettings,
  tools,
  history,
  parts,
  originalMessage,
  channelId,
  historyId,
  effectiveSettings,
  originalPrompt   = '',
  allAttachments   = [],
  preparedMessages = null
) {
  const userId  = originalMessage.author.id;
  const guildId = originalMessage.guild?.id;

  const responseFormat    = effectiveSettings.responseFormat    || BOT_CONFIG.DEFAULT_RESPONSE_FORMAT;
  const showActionButtons = effectiveSettings.showActionButtons ?? getDefaultUserSettings().showActionButtons;
  const continuousReply   = effectiveSettings.continuousReply   ?? getDefaultUserSettings().continuousReply;
  const maxCharLimit      = responseFormat === 'Embedded' ? CHARACTER_LIMITS.EMBEDDED : CHARACTER_LIMITS.NORMAL;

  let currentModelIndex = MODEL_FALLBACK_CHAIN.indexOf(modelName);
  if (currentModelIndex === -1) { currentModelIndex = 0; modelName = MODEL_FALLBACK_CHAIN[0]; }

  let attempts       = MAX_RETRY_ATTEMPTS;
  let modelAttempts  = 0;
  const maxModelAttempts = MODEL_FALLBACK_CHAIN.length;

  // Outer mutable state shared across retry iterations
  let updateTimeout      = null;
  let tempResponse       = '';
  let groundingMetadata  = null;
  let urlContextMetadata = null;
  let botMessage         = initialBotMessage;

  // ── Helpers ────────────────────────────────────────────────────────────────

  const shouldForceReply = () =>
    !continuousReply ||
    (guildId && originalMessage.channel.lastMessageId !== originalMessage.id);

  const scheduleUpdate = () => {
    if (updateTimeout) return;
    updateTimeout = setTimeout(async () => {
      updateTimeout = null;
      if (!botMessage || !tempResponse.trim()) return;
      try {
        if (responseFormat === 'Embedded') {
          updateEmbed(botMessage, tempResponse, originalMessage, groundingMetadata, urlContextMetadata, effectiveSettings);
        } else {
          await botMessage.edit({ content: tempResponse, embeds: [] }).catch(() => {});
        }
      } catch { /* swallow — best-effort update */ }
    }, UPDATE_DEBOUNCE_MS);
  };

  const cleanup = () => {
    typingManager.stop(channelId);
    if (updateTimeout) { clearTimeout(updateTimeout); updateTimeout = null; }
  };

  // ── Build large-response embed (used twice in stream loop) ─────────────────
  const largResponseEmbed = () =>
    new EmbedBuilder()
      .setColor(0xFFAA00)
      .setTitle('📄 Large Response')
      .setDescription('The response is too large. It will be sent as a text file once completed.');

  // ── Consume one stream, accumulating text and function calls ───────────────
  // IMPORTANT: for Gemini 3 built-in + custom tool combinations, the API
  // requires `id` and `thought_signature` to be passed back in the model turn.
  // We capture the full raw part objects (not just chunk.functionCalls) so
  // those fields survive the round-trip intact.
  const drainStream = async (stream, params) => {
    const { onFunctionCall } = params;
    let finalResponse = params.initialResponse || '';

    for await (const chunk of stream) {
      // Capture raw parts that are functionCall type — preserves id + thought_signature
      if (chunk.candidates?.[0]?.content?.parts) {
        const fcParts = chunk.candidates[0].content.parts.filter(p => p.functionCall);
        if (fcParts.length) onFunctionCall(fcParts);
      } else if (chunk.functionCalls?.length) {
        // Fallback for older SDK response shape
        onFunctionCall(chunk.functionCalls.map(fc => ({ functionCall: fc })));
      }

      const chunkText = extractChunkText(chunk, modelName);
      if (chunkText) {
        finalResponse += chunkText;
        tempResponse  += chunkText;

        // Create the Discord message once we have enough text
        if (!botMessage && tempResponse.length > CHAR_THRESHOLD) {
          botMessage = shouldForceReply()
            ? await originalMessage.reply({ content: tempResponse })
            : await originalMessage.channel.send({ content: tempResponse });
          // Discord auto-clears typing when a message is sent, but our interval
          // would re-trigger sendTyping() ~4s later while we're only editing.
          // Stop the interval now — subsequent updates are edits, not sends.
          typingManager.stop(channelId);
        }

        if (botMessage) {
          if (finalResponse.length > maxCharLimit && !params.isLargeRef.value) {
            params.isLargeRef.value = true;
            botMessage.edit({ content: ' ', embeds: [largResponseEmbed()], components: [] }).catch(() => {});
          } else if (!params.isLargeRef.value) {
            scheduleUpdate();
          }
        }
      }

      if (chunk.candidates?.[0]?.groundingMetadata)                        groundingMetadata   = chunk.candidates[0].groundingMetadata;
      if (!isGemmaModel(modelName) && chunk.candidates?.[0]?.url_context_metadata) urlContextMetadata  = chunk.candidates[0].url_context_metadata;
    }

    return finalResponse;
  };

  // ── Tool helpers ───────────────────────────────────────────────────────────
  // Gemini 3 supports combining built-in tools (googleSearch, urlContext,
  // codeExecution) with functionDeclarations in a single request.
  // Older Gemini models throw 400 if you mix them — strip built-in tools.
  // Gemma models: googleSearch works, but urlContext/codeExecution do not.
  const isModernGemini = (name) => /^gemini-(?:3|4)/i.test(name);
  const isGemma   = (name) => isGemmaModel(name);
  const supportsTools = (name) => getModelMetadata(name)?.supportsTools === true;
  const supportsBuiltInTools = (name) => getModelMetadata(name)?.supportsBuiltInTools === true;

  // Gemini models with native Search should use that built-in instead of duplicate function routing.
  const stripGoogleSearchFn = (tools) =>
    tools.map(t => {
      if (!t.functionDeclarations) return t;
      const filtered = t.functionDeclarations.filter(fn => fn.name !== 'google_search');
      return filtered.length ? { functionDeclarations: filtered } : null;
    }).filter(Boolean);

  const resolveTools = (allTools, name) => {
    const allowWebSearch = getRuntimeFeatureFlag('ENABLE_WEB_SEARCH');
    const allowFunctionCalling = getRuntimeFeatureFlag('ENABLE_FUNCTION_CALLING');
    let selected = Array.isArray(allTools) ? [...allTools] : [];
    if (!allowWebSearch) {
      selected = selected.filter(tool => !Object.hasOwn(tool, 'googleSearch'));
      selected = selected.map(tool => {
        if (!Array.isArray(tool.functionDeclarations)) return tool;
        const functionDeclarations = tool.functionDeclarations.filter(fn => fn.name !== 'google_search');
        return functionDeclarations.length ? { ...tool, functionDeclarations } : null;
      }).filter(Boolean);
    }
    if (!allowFunctionCalling) selected = selected.filter(tool => !Array.isArray(tool.functionDeclarations));
    if (!supportsTools(name)) return [];
    if (!supportsBuiltInTools(name)) {
      // Gemma supports custom function declarations but not this application's
      // Gemini-hosted built-in tool bundle. Send only the custom function schema.
      return selected.filter(tool => Array.isArray(tool.functionDeclarations));
    }
    if (isModernGemini(name)) {
      return allowWebSearch ? stripGoogleSearchFn(selected) : selected;
    }
    // Older Gemini: function declarations only; built-in tools are unsupported.
    return stripGoogleSearchFn(selected.filter(tool => tool.functionDeclarations));
  };

  const resolveToolConfig = (name) =>
    supportsBuiltInTools(name) && isModernGemini(name) ? { includeServerSideToolInvocations: true } : undefined;

  // ── Main retry loop ────────────────────────────────────────────────────────

  try {
    while (modelAttempts < maxModelAttempts && attempts > 0) {
      try {
        let finalResponse  = '';
        const isLargeRef   = { value: false };   // boxed bool so drainStream can mutate it
        const newHistory   = [{ role: 'user', content: parts }];

        const generationConfig = getGenerationConfig(modelName);
        logger.debug(`Using model: ${modelName} (attempt ${modelAttempts + 1}/${maxModelAttempts})`);

        const effectiveTools   = resolveTools(tools, modelName);
        const effectiveToolCfg = resolveToolConfig(modelName);

        const request = {
          model:    modelName,
          contents: [
            ...(history || []).filter(Boolean),
            { role: 'user', parts: (parts || []).filter(Boolean) }
          ],
          config: {
            systemInstruction,
            ...(generationConfig || {}),
            tools: effectiveTools,
            safetySettings: getSafetySettings(modelName),
            ...(effectiveToolCfg ? { toolConfig: effectiveToolCfg } : {})
          }
        };

        const stream = await genAI.models.generateContentStream(request);
        if (!stream) throw new Error('API returned undefined — check API keys');

        // NOTE: do NOT stop the typing indicator before streaming begins. The
        // stream object is obtained before any tokens are generated. Stopping
        // typing now causes a visible 2–3 s gap where typing has disappeared
        // but no Discord message exists yet.
        //
        // Typing is stopped at two points instead:
        //   1. Inside drainStream, the moment the first botMessage is created
        //      via reply/send — Discord auto-clears the indicator on send, and
        //      we stop the interval so it can't re-trigger while we're editing.
        //   2. Right after drainStream returns (below) — covers the
        //      initialBotMessage path where no new message is ever sent and
        //      Discord never gets a chance to auto-clear the indicator.

        let functionCallParts = [];  // now stores raw Part objects {functionCall, id?, thought_signature?}
        const onFunctionCall  = (parts) => functionCallParts.push(...parts);

        finalResponse = await drainStream(stream, { onFunctionCall, isLargeRef, initialResponse: '' });

        // Stream fully drained — stop typing now regardless of path taken.
        // For the reply/send path this is a no-op (already stopped inside
        // drainStream). For the initialBotMessage/edit-only path this is the
        // first and only chance to clear the indicator before final formatting.
        typingManager.stop(channelId);

        // ── Function calling loop ────────────────────────────────────────
        // Gemini 3 built-in + custom tool combination requirement:
        //   - model turn must include the raw parts (with id + thought_signature)
        //   - function result parts must reference matching id fields
        //   [history…, user_message, model_fc_parts, user_fc_results]
        if (functionCallParts.length > 0) {
          logger.debug(`Executing ${functionCallParts.length} function call(s)…`);

          let functionTurnCount = 0;

          while (functionCallParts.length > 0 && functionTurnCount < MAX_FUNCTION_CALL_TURNS) {
            functionTurnCount++;
            logger.debug(`Function turn ${functionTurnCount}/${MAX_FUNCTION_CALL_TURNS}`);

            // Extract the actual call descriptors for the executor
            const callDescriptors = functionCallParts.map(p =>
              p.functionCall ? p.functionCall : p  // handle both shapes
            );

            const functionResponses = await executeFunctionCalls(
              callDescriptors, userId, guildId, historyId,
              channelId,
              originalMessage.id,
              modelName
            );

            // If every function result is marked silent (edit, delete, etc.)
            // skip the follow-up generation so the bot sends no confirmation reply.
            const allSilent = functionResponses.every(
              r => r?.functionResponse?.response?._silent === true
            );
            if (allSilent) {
              logger.debug('Silent function turn — skipping follow-up response');
              if (botMessage) {
                await botMessage.delete().catch(() => {});
                botMessage = null;
              }
              functionCallParts = [];
              break;
            }

            // Modern Gemini: pass thought_signature + id back exactly as received (required).
            // Gemma: no thought_signature ever — pass parts as-is.
            // Other Gemini (e.g. 3.5-flash): strip BOTH thought_signature AND id —
            //   sending either triggers "context circulation not enabled" 400 error.
            const sanitizedFcParts = (isModernGemini(modelName) && !isGemma(modelName))
              ? functionCallParts
              : functionCallParts.map(({ thought_signature, thoughtSignature, id, ...rest }) => rest);

            const turnContents = [
              ...(history || []).filter(Boolean),
              { role: 'user',  parts: (parts || []).filter(Boolean) },
              { role: 'model', parts: sanitizedFcParts },
              { role: 'user',  parts: functionResponses }
            ];

            const nextRequest = {
              model:    modelName,
              contents: turnContents,
              config:   {
                systemInstruction,
                ...(generationConfig || {}),
                tools: effectiveTools,
                safetySettings: getSafetySettings(modelName),
                ...(effectiveToolCfg ? { toolConfig: effectiveToolCfg } : {})
              }
            };

            const nextStream = await genAI.models.generateContentStream(nextRequest);

            // Reset for next turn
            finalResponse     = '';
            tempResponse      = '';
            functionCallParts = [];

            finalResponse = await drainStream(nextStream, { onFunctionCall, isLargeRef, initialResponse: '' });

            if (!functionCallParts.length) break;
          }

          if (functionTurnCount >= MAX_FUNCTION_CALL_TURNS && functionCallParts.length > 0) {
            logger.warn(`Function calling limit reached (${MAX_FUNCTION_CALL_TURNS} turns), stopping`);
            // Do NOT append anything to finalResponse — just continue with whatever text the model produced
          }
        }

        // ── Flush pending debounced edit ─────────────────────────────────
        if (updateTimeout) { clearTimeout(updateTimeout); updateTimeout = null; }

        // ── Send if entire response was below initial threshold ──────────
        let wasShortResponse = false;
        if (!botMessage && finalResponse) {
          wasShortResponse = true;
          botMessage = shouldForceReply()
            ? await originalMessage.reply({ content: finalResponse })
            : await originalMessage.channel.send({ content: finalResponse });
        }

        newHistory.push({ role: 'assistant', content: [{ text: finalResponse }] });

        // ── Apply final format ───────────────────────────────────────────
        if (botMessage) {
          if (!isLargeRef.value && responseFormat === 'Embedded') {
            updateEmbed(botMessage, finalResponse, originalMessage, groundingMetadata, urlContextMetadata, effectiveSettings);
          } else if (!isLargeRef.value && !wasShortResponse) {
            // Fix: if Normal-mode response exceeds Discord's 2000-char hard limit, send as file
            if (finalResponse.length > CHARACTER_LIMITS.DISCORD_MAX) {
              isLargeRef.value = true;
            } else {
              await botMessage.edit({
                content: finalResponse,
                embeds:  []
              }).catch(() => {});
            }
          }
        }

        if (isLargeRef.value && botMessage) {
          botMessage = await sendAsTextFile(finalResponse, originalMessage, botMessage.id, continuousReply);
        }

        if (showActionButtons && botMessage && !isLargeRef.value) {
          botMessage = await addDownloadButton(botMessage);
          botMessage = await addDeleteButton(botMessage, botMessage.id, userId);
        }

        // ── Persist history ──────────────────────────────────────────────
        if (newHistory.length > 1 && botMessage) {
          await saveMessageHistory({
            historyId,
            userId,
            guildId,
            newHistory,
            finalResponse,
            botMessageId: botMessage.id,
            originalMessage,
            preparedMessages
          });
        }

        // ── Track bot message for edit/delete tools ──────────────────────
        if (botMessage) {
          setLastBotMessage(historyId, botMessage.id, channelId);
        }

        // ── Deliver pending sticker (queued by get_server_stickers tool) ─
        const pendingStickerId = consumePendingSticker(historyId);
        if (pendingStickerId) {
          try {
            await originalMessage.channel.send({ stickers: [pendingStickerId] });
          } catch (stickerErr) {
            logger.warn(`Failed to send sticker ${pendingStickerId}: ${stickerErr.message}`);
          }
        }

        // ── Deliver pending GIF/meme as a file attachment ────────────────
        // Passing a remote URL to `files` lets Discord.js download and post
        // it as an inline attachment — no URL text visible, GIFs still animate.
        const pendingGifUrl = consumePendingGif(historyId);
        if (pendingGifUrl) {
          try {
            await originalMessage.channel.send({ files: [pendingGifUrl] });
          } catch (gifErr) {
            logger.warn(`Failed to send GIF attachment: ${gifErr.message}`);
          }
        }

        // ── Deliver profile avatar/banner only if model echoed the URL ───
        // The model is instructed to include the _avatar_ or _banner_ URL in
        // its reply ONLY when the user explicitly asked for pfp/banner.
        // We intercept those marker lines, strip them from the visible reply,
        // and re-send them as clean image attachments instead.
        const profileMediaRegex = /^_(?:avatar|banner)_:\s*(https?:\/\/\S+)$/m;
        if (finalResponse && profileMediaRegex.test(finalResponse)) {
          const urls = [];
          finalResponse = finalResponse.replace(
            /^_(?:avatar|banner)_:\s*(https?:\/\/\S+)$/gm,
            (_, url) => { urls.push(url); return ''; }
          ).trim();
          for (const url of urls) {
            try {
              await originalMessage.channel.send({ files: [url] });
            } catch (mediaErr) {
              logger.warn(`Failed to send profile media attachment: ${mediaErr.message}`);
            }
          }
        }

        cleanup();
        return; // success

      } catch (error) {
        attempts--;

        // ── File permission error (expired Gemini file URI) ──────────────
        if (isFileError(error)) {
          logger.warn(`File permission error — cleaning history: ${error.message}`);
          history = cleanHistoryFiles(history);
          parts   = parts.filter(p => !p.fileUri && !p.fileData);
          if (!parts.some(p => p.text?.trim())) {
            parts.unshift({ text: '[Previous file attachments were removed due to API key limitations. Please re-upload files if needed, or continue the conversation without them.]' });
          }
          if (attempts > 0) {
            typingManager.start(originalMessage.channel);
            await sleep(RETRY_DELAYS.FILE_ERROR);
            continue;
          }
        }

        // ── API key rotation ─────────────────────────────────────────────
        const { keyRotated } = await switchToNextKeyOrModel(error, modelName);
        if (keyRotated && attempts > 0) {
          typingManager.start(originalMessage.channel);
          try {
            const { supported: filteredForModel } = classifyAttachments(allAttachments, modelName);
            const [cleanedHistory, reprocessedParts] = await Promise.all([
              Promise.resolve(cleanHistoryFiles(history)),
              (async () => {
                const { finalPrompt, summaryParts } = await extractFileText(originalMessage, originalPrompt);
                const updated = await processPromptAndMediaAttachments(finalPrompt, originalMessage, filteredForModel, modelName);
                if (summaryParts?.length) updated.push(...summaryParts);
                return updated;
              })()
            ]);
            history = cleanedHistory;
            parts   = reprocessedParts;
            continue;
          } catch (reErr) {
            logger.error('Failed to re-prepare context after key rotation', reErr);
          }
        }

        // ── Rate-limit → model fallback ──────────────────────────────────
        if (isRateLimitError(error)) {
          logger.warn(`Rate limit on ${modelName}, falling back…`);
          typingManager.start(originalMessage.channel);
          currentModelIndex++;
          if (currentModelIndex < MODEL_FALLBACK_CHAIN.length) {
            modelName     = MODEL_FALLBACK_CHAIN[currentModelIndex];
            modelAttempts++;
            attempts      = MAX_RETRY_ATTEMPTS;
            await sleep(RETRY_DELAYS.RATE_LIMIT);
            continue;
          }
        }

        // ── All attempts exhausted ───────────────────────────────────────
        if (attempts === 0 && modelAttempts >= maxModelAttempts - 1) {
          cleanup();
          const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('❌ Generation Failed')
            .setDescription(
              `All models failed. Last error: ${error.message || 'Unknown error'}\n\n` +
              `Tried: ${MODEL_FALLBACK_CHAIN.slice(0, modelAttempts + 1).join(', ')}`
            );
          try {
            if (shouldForceReply()) await originalMessage.reply({ embeds: [embed] });
            else await originalMessage.channel.send({ embeds: [embed] });
          } catch { /* swallow */ }
          return;
        }

        await sleep(RETRY_DELAYS.DEFAULT);
      }
    }
  } catch (outerError) {
    logger.error('Critical error in handleModelResponse', outerError);
    try {
      await originalMessage.reply({
        embeds: [Embeds.error('Critical Error', 'An unexpected error occurred while processing your message. Please try again.')]
      });
    } catch { /* swallow */ }
  } finally {
    clearPendingSticker(historyId);
    clearPendingGif(historyId);
    cleanup();
  }
}
