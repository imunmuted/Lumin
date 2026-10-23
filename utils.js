/**
 * @fileoverview Shared utility functions used across Lumin v2.
 *               Lives at the project root so any module can reach it with a
 *               simple `../../utils.js` (or `../utils.js` from commands/).
 *
 * Exports:
 *   initializeBlacklistForGuild  — ensure guild state is bootstrapped
 *   uploadText                   — paste text to bin.mudfish.net
 *   parseDiscordMessageLink      — parse a Discord message URL into components
 *   fetchMessagesForSummary      — fetch + format messages around a link
 *   downloadAndReadFile          — download a text/office file as a string
 *   parseRelativeTime            — parse "5 minutes" / "2 hours" → Date
 *
 * NOTE: mention replacement (replaceAllMentions) is **not** re-implemented
 * here — it lives in modules/shared/discordHelpers.js and is imported from
 * there. The duplicate internal implementation that existed in the original
 * utils.js has been removed.
 *
 * @module utils
 */

import { PermissionsBitField } from 'discord.js';
import axios                   from 'axios';
import { getTextExtractor }    from 'office-text-extractor';

import { state, client, DEFAULT_SERVER_SETTINGS, getDefaultServerSettings } from './managers/BotManager.js';
import { replaceAllMentions }                      from './modules/shared/discordHelpers.js';
import { Logger }                                  from './core/Logger.js';
import {
  UPLOAD_CONFIG,
  MESSAGE_FETCH_CONFIG as MESSAGE_FETCH
} from './modules/config.js';

const logger = Logger.get('Utils');

// ============================================================================
// SECURITY: URL VALIDATION
// Blocks SSRF by rejecting non-HTTP(S) protocols and private/loopback ranges.
// Applied to all outbound fetch calls that accept caller-supplied URLs.
// ============================================================================

const SAFE_PROTOCOLS   = new Set(['http:', 'https:']);
// Covers IPv4 loopback, private ranges (RFC1918), link-local, and IPv6 loopback.
const BLOCKED_HOST_RE  = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/i;
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5 MB cap on plain-text downloads

/**
 * Validate a URL is safe for outbound requests.
 * Throws on invalid URL, non-HTTP(S) protocol, or private/loopback hosts.
 * @param {string} url
 * @returns {URL} Parsed URL object
 */
function validateOutboundUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Disallowed protocol "${parsed.protocol}" in URL`);
  }
  if (BLOCKED_HOST_RE.test(parsed.hostname)) {
    throw new Error(`Blocked hostname "${parsed.hostname}" — private/loopback addresses are not allowed`);
  }
  return parsed;
}

const DISCORD_LINK_REGEX =
  /https?:\/\/(?:www\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;

const PERMISSIONS = Object.freeze({
  VIEW_CHANNEL: PermissionsBitField.Flags.ViewChannel,
  READ_HISTORY: PermissionsBitField.Flags.ReadMessageHistory
});

const ERR = Object.freeze({
  NO_SERVER:      "I don't have access to that server.",
  NO_CHANNEL:     "I don't have access to that channel.",
  NO_PERMISSIONS: "I don't have permission to read messages in that channel.",
  NOT_FOUND:      'Could not find that message. It may have been deleted.',
  FETCH_ERROR:    'An error occurred while fetching the messages.',
  UPLOAD_FAILED:  'URL generation failed',
  DOWNLOAD_FAIL:  'Failed to download'
});

const OFFICE_EXTENSIONS = new Set(['.pptx', '.docx']);

const MSG_FMT = Object.freeze({
  SEPARATOR:        '---',
  MSG_PREFIX:       '**Message',
  AUTHOR_PREFIX:    '** - **',
  AUTHOR_SUFFIX:    '** (',
  TIMESTAMP_SUFFIX: '):\n',
  ATTACH_PREFIX:    '[Attachment: ',
  ATTACH_SUFFIX:    ']',
  EMBED_PREFIX:     '[Contains ',
  EMBED_SUFFIX:     ' embed(s)]'
});

// ============================================================================
// GUILD STATE INITIALISATION
// ============================================================================

function ensureServerSettingsComplete(settings) {
  if (!settings.allowedChannels)           settings.allowedChannels    = [];
  if (settings.showActionButtons === undefined)
    settings.showActionButtons = DEFAULT_SERVER_SETTINGS.showActionButtons;
  if (settings.continuousReply  === undefined)
    settings.continuousReply   = DEFAULT_SERVER_SETTINGS.continuousReply;
  return settings;
}

/**
 * Ensure `state.blacklistedUsers[guildId]` and `state.serverSettings[guildId]`
 * are initialised with safe defaults.
 *
 * @param {string} guildId
 */
export function initializeBlacklistForGuild(guildId) {
  try {
    if (!state.blacklistedUsers[guildId]) state.blacklistedUsers[guildId] = [];

    if (!state.serverSettings[guildId]) {
      state.serverSettings[guildId] = getDefaultServerSettings();
    } else {
      state.serverSettings[guildId] = ensureServerSettingsComplete(state.serverSettings[guildId]);
    }
  } catch (error) {
    logger.error('Error initializing blacklist for guild', error);
  }
}

// ============================================================================
// TEXT UPLOAD (bin.mudfish.net)
// ============================================================================

/**
 * Upload `text` to bin.mudfish.net and return a `\n🔗 URL: …` suffix string,
 * or `\n❌ URL generation failed` on error.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
/**
 * Upload `text` to bin.mudfish.net and return a `\n🔗 URL: …` suffix string.
 * The paste site's response `tid` is validated to contain only safe characters
 * before being embedded in a URL, preventing open-redirect via a malicious tid.
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function uploadText(text) {
  try {
    const response = await axios.post(
      `${UPLOAD_CONFIG.SITE_URL}${UPLOAD_CONFIG.ENDPOINT}`,
      { text, ttl: UPLOAD_CONFIG.TTL_MINUTES },
      { timeout: UPLOAD_CONFIG.TIMEOUT_MS }
    );
    const tid = response.data?.tid;
    // Validate tid is a safe alphanumeric token before using in URL construction.
    if (!tid || !/^[\w-]{1,64}$/.test(String(tid))) {
      logger.warn('uploadText: received unexpected tid format from paste service');
      return `\n❌ ${ERR.UPLOAD_FAILED}`;
    }
    return `\n🔗 URL: ${UPLOAD_CONFIG.SITE_URL}/t/${tid}`;
  } catch (error) {
    logger.error('uploadText error', error);
    return `\n❌ ${ERR.UPLOAD_FAILED}`;
  }
}

// ============================================================================
// DISCORD MESSAGE LINK PARSING
// ============================================================================

/**
 * Parse a Discord message URL into its component IDs.
 *
 * @param {string} url
 * @returns {{ guildId: string, channelId: string, messageId: string }|null}
 */
export function parseDiscordMessageLink(url) {
  const match = url.match(DISCORD_LINK_REGEX);
  if (!match) return null;
  return { guildId: match[1], channelId: match[2], messageId: match[3] };
}

// ============================================================================
// MESSAGE FETCHING FOR SUMMARY COMMAND
// ============================================================================

function validateGuildAccess(guildId) {
  const guild = client.guilds.cache.get(guildId);
  return guild ? { valid: true, guild } : { valid: false, error: ERR.NO_SERVER };
}

function validateChannelAccess(guild, channelId) {
  const channel = guild.channels.cache.get(channelId);
  return channel ? { valid: true, channel } : { valid: false, error: ERR.NO_CHANNEL };
}

function validateChannelPermissions(channel) {
  const perms = channel.permissionsFor(client.user);
  if (!perms.has(PERMISSIONS.VIEW_CHANNEL) || !perms.has(PERMISSIONS.READ_HISTORY)) {
    return { valid: false, error: ERR.NO_PERMISSIONS };
  }
  return { valid: true };
}

async function fetchStartMessage(channel, messageId) {
  const msg = await channel.messages.fetch(messageId).catch(() => null);
  return msg
    ? { success: true,  message: msg }
    : { success: false, error: ERR.NOT_FOUND };
}

async function fetchSurroundingMessages(channel, messageId, count) {
  if (count <= MESSAGE_FETCH.DEFAULT_COUNT) return { older: [], newer: [] };

  const additional = Math.min(count - 1, MESSAGE_FETCH.MAX_ADDITIONAL);
  const half       = Math.floor(additional / 2);

  try {
    const [olderMap, newerMap] = await Promise.all([
      channel.messages.fetch({ before: messageId, limit: half }).catch(() => null),
      channel.messages.fetch({ after:  messageId, limit: additional - half }).catch(() => null)
    ]);

    const sort = map => map
      ? Array.from(map.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      : [];

    return { older: sort(olderMap), newer: sort(newerMap) };
  } catch (error) {
    logger.error('Error fetching surrounding messages', error);
    return { older: [], newer: [] };
  }
}

/**
 * Format a single message into a readable string, replacing all mentions.
 * Uses `replaceAllMentions` from discordHelpers (not an internal duplicate).
 *
 * @param {import('discord.js').Message} msg
 * @param {number} index
 * @param {import('discord.js').Guild}   guild
 * @returns {Promise<string>}
 */
async function formatMessageContent(msg, index, guild) {
  let content =
    `${MSG_FMT.MSG_PREFIX} ${index + 1}${MSG_FMT.AUTHOR_PREFIX}${msg.author.username}` +
    `${MSG_FMT.AUTHOR_SUFFIX}${msg.createdAt.toLocaleString()}${MSG_FMT.TIMESTAMP_SUFFIX}`;

  if (msg.content) {
    content += await replaceAllMentions(msg.content, guild);
  }

  if (msg.attachments.size > 0) {
    const list = Array.from(msg.attachments.values())
      .map(a => `${MSG_FMT.ATTACH_PREFIX}${a.name}${MSG_FMT.ATTACH_SUFFIX}`)
      .join(', ');
    content += `\n${list}`;
  }

  if (msg.embeds.length > 0) {
    content += `\n${MSG_FMT.EMBED_PREFIX}${msg.embeds.length}${MSG_FMT.EMBED_SUFFIX}`;
    for (const [i, embed] of msg.embeds.entries()) {
      if (embed.title || embed.description) {
        content += `\n[Embed ${i + 1}]:`;
        if (embed.title) {
          content += `\n  Title: ${await replaceAllMentions(embed.title, guild)}`;
        }
        if (embed.description) {
          const clean = await replaceAllMentions(embed.description, guild);
          content += `\n  Description: ${clean.length > 200 ? clean.slice(0, 200) + '...' : clean}`;
        }
        if (embed.fields?.length > 0) {
          for (const field of embed.fields) {
            const name  = await replaceAllMentions(field.name,  guild);
            const value = await replaceAllMentions(field.value, guild);
            content += `\n  ${name}: ${value}`;
          }
        }
      }
    }
  }

  return content;
}

/**
 * Fetch and format messages around a Discord message link for the /summary command.
 *
 * @param {import('discord.js').Message} _message  - Unused; kept for caller API compat
 * @param {string}  messageLink
 * @param {number}  [count=1]
 * @returns {Promise<{ success: true, content: string, messageCount: number, channelName: string, guildName: string }
 *                  | { error: string }
 *                  | null>}
 */
export async function fetchMessagesForSummary(_message, messageLink, count = MESSAGE_FETCH.DEFAULT_COUNT) {
  try {
    const parsed = parseDiscordMessageLink(messageLink);
    if (!parsed) return null;

    const { guildId, channelId, messageId } = parsed;

    const guildResult = validateGuildAccess(guildId);
    if (!guildResult.valid)   return { error: guildResult.error };

    const channelResult = validateChannelAccess(guildResult.guild, channelId);
    if (!channelResult.valid) return { error: channelResult.error };

    const permResult = validateChannelPermissions(channelResult.channel);
    if (!permResult.valid)    return { error: permResult.error };

    const startResult = await fetchStartMessage(channelResult.channel, messageId);
    if (!startResult.success) return { error: startResult.error };

    let messages = [startResult.message];
    if (count > MESSAGE_FETCH.DEFAULT_COUNT) {
      const { older, newer } = await fetchSurroundingMessages(channelResult.channel, messageId, count);
      messages = [...older, startResult.message, ...newer];
    }

    const formatted = await Promise.all(
      messages.map((msg, i) => formatMessageContent(msg, i, guildResult.guild))
    );

    return {
      success:      true,
      content:      formatted.join(`\n\n${MSG_FMT.SEPARATOR}\n\n`),
      messageCount: messages.length,
      channelName:  channelResult.channel.name,
      guildName:    guildResult.guild.name
    };
  } catch (error) {
    logger.error('Error fetching messages for summary', error);
    return { error: ERR.FETCH_ERROR };
  }
}

// ============================================================================
// FILE DOWNLOAD
// ============================================================================

/**
 * Download a file from `url` and return its text content.
 * Supports `.pptx` / `.docx` via office-text-extractor, plain text otherwise.
 *
 * @param {string} url
 * @param {string} fileType  - e.g. '.docx', '.txt'
 * @returns {Promise<string>}
 */
/**
 * Download a file from `url` and return its text content.
 * Supports `.pptx`/`.docx` via office-text-extractor, plain text otherwise.
 * FIX: `validateOutboundUrl` blocks private/loopback SSRF targets.
 * FIX: plain-text downloads are capped at MAX_DOWNLOAD_BYTES to prevent OOM.
 * @param {string} url
 * @param {string} fileType — e.g. '.docx', '.txt'
 * @returns {Promise<string>}
 */
export async function downloadAndReadFile(url, fileType) {
  validateOutboundUrl(url); // throws on unsafe URLs

  if (OFFICE_EXTENSIONS.has(fileType)) {
    const extractor = getTextExtractor();
    return await extractor.extractText({ input: url, type: 'url' });
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${ERR.DOWNLOAD_FAIL} ${response.statusText}`);
  }

  // Guard against oversized responses filling Node.js RAM.
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${ERR.DOWNLOAD_FAIL}: response too large (${contentLength} bytes)`);
  }

  const text = await response.text();
  if (text.length > MAX_DOWNLOAD_BYTES) {
    throw new Error(`${ERR.DOWNLOAD_FAIL}: decoded content exceeds size limit`);
  }
  return text;
}

// ============================================================================
// TIME PARSING
// ============================================================================

/** @type {Record<string, number>} */
const TIME_UNITS = {
  minute:  60 * 1000,
  minutes: 60 * 1000,
  hour:    60 * 60 * 1000,
  hours:   60 * 60 * 1000,
  day:     24 * 60 * 60 * 1000,
  days:    24 * 60 * 60 * 1000,
  week:    7  * 24 * 60 * 60 * 1000,
  weeks:   7  * 24 * 60 * 60 * 1000
};

/**
 * Parse a relative time string like "5 minutes" or "2 hours" into a future Date.
 * Falls back to +1 hour if the pattern is not recognised.
 *
 * @param {string} relativeTimeStr
 * @returns {Date}
 *
 * @example
 * parseRelativeTime('30 minutes') // → Date 30 min from now
 * parseRelativeTime('2 hours')    // → Date 2 hours from now
 */
export function parseRelativeTime(relativeTimeStr) {
  const match = relativeTimeStr.match(/(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks)/i);
  if (match) {
    const value    = parseInt(match[1], 10) || 0;
    const unitMs   = TIME_UNITS[match[2].toLowerCase()] || 60_000;
    return new Date(Date.now() + value * unitMs);
  }
  return new Date(Date.now() + 60 * 60 * 1000); // fallback: +1 hour
}
