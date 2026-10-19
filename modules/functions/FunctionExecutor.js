/**
 * @fileoverview Runtime execution of Gemini function calls.
 *               Each handler is a focused async function; `executeFunctionCalls`
 *               fans out all calls in parallel and returns the API-shaped results.
 * @module modules/functions/FunctionExecutor
 */

import * as db                       from '../../database/index.js';
import { memorySystem }              from '../../memory/MemorySystem.js';
import { state, saveStateToFile, client, genAI, BOT_CONFIG } from '../../managers/BotManager.js';
import { scheduleReminder }          from '../../commands/reminder/ReminderScheduler.js';
import { parseRelativeTime }         from '../../utils.js';
import { formatDuration }            from '../shared/messageFormatter.js';
import { Logger }                    from '../../core/Logger.js';
import { FUNCTION_NAMES, MEMORY_ACTIONS } from './FunctionRegistry.js';
import { vectorSearchOldSessions, getRecentSessionContext } from '../../commands/summary/SessionSummaryJob.js';
import { setPendingSticker, setPendingGif, getLastBotMessage } from './pendingMedia.js';
import { isGemmaModel, SYSTEM_AGENT_CALLSIGN }                  from '../config.js';
import axios                             from 'axios';

const logger = Logger.get('FunctionExecutor');

// ============================================================================
// RESPONSE STRING CONSTANTS
// ============================================================================

const MSG = Object.freeze({
  MEMORY_ADD_SUCCESS:   'Memory added',
  MEMORY_REMOVE_SUCCESS:'Memory removed',
  NO_MEMORIES_FOUND:    'No relevant memories found.',
  REMINDER_SET:         'Reminder set for',
  BIRTHDAY_SET:         'Birthday set to',
  TIMEZONE_SET:         'Timezone set to',
  TIME_CHECKED:         'Time elapsed since last message:',
  OPERATION_FAILED:     'Failed',
  GIF_NO_API_KEY:       'GIF search is unavailable: GIPHY_API_KEY is not configured.',
  GIF_NO_RESULTS:       'No GIF found for that search.',
  GIF_API_ERROR:        'GIF search failed.',
  NO_GUILD:             'This tool is only available in server channels, not DMs.',
  NO_DMS:               'This tool is only available in DM conversations.',
  STICKER_QUEUED:       'Sticker queued for delivery.',
  STICKER_NOT_FOUND:    'Sticker not found on this server.',
  NO_PERMISSION:        'Missing permission to perform this action.',
  NOT_FOUND:            'Not found.'
});

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

function padDateComponent(value, padLength) {
  return String(value).padStart(padLength, '0');
}

function generateReminderId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createReminderObject(userId, message, timeDate, channelId = null) {
  return { id: generateReminderId(), userId, message, time: timeDate.getTime(), channelId, active: true };
}

function initializeUserReminders(userId) {
  if (!state.reminders) state.reminders = {};
  if (!state.reminders[userId]) state.reminders[userId] = [];
}

function createBirthdayData(month, day, guildId) {
  return {
    month:      padDateComponent(parseInt(month, 10), 2),
    day:        padDateComponent(parseInt(day, 10),   2),
    nameType:   'self',
    preference: 'both',
    guildId
  };
}

/** Format bytes to human-readable size. */
function fmtBytes(b) {
  if (!b) return '0 B';
  const k = 1024, units = ['B','KB','MB','GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${(b / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
}

/** Format a Date to a readable string. */
function fmtDate(d) {
  if (!d) return 'Unknown';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ============================================================================
// ENTITY RESOLUTION HELPER
// ============================================================================

/**
 * Scan a fact/memory string for raw Discord mention patterns and replace them
 * with fully-labelled identifiers before anything is written to the database.
 * This runs at save-time so every stored fact is uniformly formatted regardless
 * of what text the AI passed in.
 *
 * Patterns resolved:
 *   <@uid> / <@!uid>  →  DisplayName/GlobalName (@username) [ID: uid]
 *   <#cid>            →  #channel-name [ID: cid]
 *   <@&rid>           →  @role-name [ID: rid]
 *
 * @param {string}      text    - The raw info string from the AI tool call.
 * @param {string|null} guildId - Current guild ID (null in DM context).
 * @returns {Promise<string>}   - Text with all mentions expanded.
 */
async function resolveEntitiesInText(text, guildId) {
  if (!text) return text;

  const guild = guildId ? client.guilds.cache.get(guildId) : null;

  // ── Users <@uid> / <@!uid> ────────────────────────────────────────────────
  const userIds = [...new Set([...text.matchAll(/<@!?(\d+)>/g)].map(m => m[1]))];
  if (userIds.length) {
    const resolved = await Promise.allSettled(
      userIds.map(id =>
        guild
          ? guild.members.fetch(id).catch(() => client.users.fetch(id).catch(() => null))
          : client.users.fetch(id).catch(() => null)
      )
    );
    userIds.forEach((uid, i) => {
      const entity = resolved[i].status === 'fulfilled' ? resolved[i].value : null;
      if (!entity) return;
      const isGuildMember  = !!entity.user;
      const user           = isGuildMember ? entity.user : entity;
      const serverDisplay  = isGuildMember ? entity.displayName : null;
      const globalDisplay  = user.globalName ?? user.username;
      // Build: ServerNick/GlobalName (@username) [ID: uid]
      const namePart = (serverDisplay && serverDisplay !== globalDisplay)
        ? `${serverDisplay}/${globalDisplay}`
        : globalDisplay;
      const label = `${namePart} (@${user.username}) [ID: ${uid}]`;
      text = text.replace(new RegExp(`<@!?${uid}>`, 'g'), label);
    });
  }

  // ── Channels <#cid> ───────────────────────────────────────────────────────
  const channelIds = [...new Set([...text.matchAll(/<#(\d+)>/g)].map(m => m[1]))];
  if (channelIds.length) {
    const resolved = await Promise.allSettled(
      channelIds.map(id => client.channels.fetch(id).catch(() => null))
    );
    channelIds.forEach((cid, i) => {
      const channel = resolved[i].status === 'fulfilled' ? resolved[i].value : null;
      if (channel?.name) {
        text = text.replace(new RegExp(`<#${cid}>`, 'g'), `#${channel.name} [ID: ${cid}]`);
      }
    });
  }

  // ── Roles <@&rid> ─────────────────────────────────────────────────────────
  const roleIds = [...new Set([...text.matchAll(/<@&(\d+)>/g)].map(m => m[1]))];
  if (roleIds.length && guild) {
    const resolved = await Promise.allSettled(
      roleIds.map(id => guild.roles.fetch(id).catch(() => null))
    );
    roleIds.forEach((rid, i) => {
      const role = resolved[i].status === 'fulfilled' ? resolved[i].value : null;
      if (role?.name) {
        text = text.replace(new RegExp(`<@&${rid}>`, 'g'), `@${role.name} [ID: ${rid}]`);
      }
    });
  }

  return text;
}

// ============================================================================
// INDIVIDUAL FUNCTION HANDLERS
// ============================================================================

// ── Memory ────────────────────────────────────────────────────────────────────

async function handleManageMemory(userId, action, info, guildId = null) {
  // Resolve any raw Discord mentions to full identifiers before storing
  const resolvedInfo = action === MEMORY_ACTIONS.ADD
    ? await resolveEntitiesInText(info, guildId)
    : info;
  if (action === MEMORY_ACTIONS.ADD) {
    await memorySystem.addPersonalData(userId, resolvedInfo);
    return { result: `${MSG.MEMORY_ADD_SUCCESS}: ${resolvedInfo}` };
  }
  await memorySystem.removePersonalData(userId, info);
  return { result: `${MSG.MEMORY_REMOVE_SUCCESS}: ${info}` };
}

async function handleManageServerFact(guildId, action, info, category = 'general') {
  if (!guildId) return { result: 'Server facts are only available in guild channels, not DMs.' };
  try {
    if (action === MEMORY_ACTIONS.ADD) {
      // Resolve any raw Discord mentions to full identifiers before storing
      const resolvedInfo = await resolveEntitiesInText(info, guildId);
      await db.saveServerFact(guildId, resolvedInfo, category);
      return { result: `Server fact saved [${category}]: ${resolvedInfo}` };
    }
    const deleted = await db.deleteServerFact(guildId, info);
    return { result: deleted > 0 ? `Server fact removed (${deleted} entries)` : 'No matching server fact found.' };
  } catch (error) {
    logger.error('handleManageServerFact failed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

async function handleSearchMemory(userId, guildId, historyId, query) {
  const crossContextEnabled = state.userSettings?.[userId]?.crossContextEnabled ?? false;
  let otherGuildIds = [];
  if (crossContextEnabled && userId) {
    try {
      otherGuildIds = client.guilds.cache
        .filter(g => g.members.cache.has(userId) && g.id !== guildId)
        .map(g => g.id);
    } catch { /* non-fatal */ }
  }

  const { embeddingService } = await import('../../memory/EmbeddingService.js');

  // Start searchMemory immediately — Phase 1 (non-embedding DB queries) and
  // Phase 2 (embedding generation) run concurrently inside it already.
  // generateEmbedding here shares the same in-flight request via EmbeddingService
  // dedup cache — zero extra API cost, both resolve together.
  const [results, queryEmbedding] = await Promise.all([
    memorySystem.searchMemory(userId, guildId, historyId, query, { crossContextEnabled, otherGuildIds }),
    embeddingService.generateEmbedding(query, 'RETRIEVAL_QUERY').catch(() => null),
  ]);

  // Session context — fast DB read (~20 ms). Embedding is fully resolved above
  // so cosine ranking is applied; no sequential wait during the main search.
  const sessionLines = await getRecentSessionContext(userId, queryEmbedding, 3);

  const all = [...sessionLines, ...results];
  return { result: all.length > 0 ? all.join('\n') : MSG.NO_MEMORIES_FOUND };
}

async function handleCheckSessions(userId, guildId, historyId, query) {
  // Generate embedding — same reuse pattern; no second embed if called after search_memory
  const { embeddingService } = await import('../../memory/EmbeddingService.js');
  const queryEmbedding = await embeddingService
    .generateEmbedding(query, 'RETRIEVAL_QUERY')
    .catch(() => null);

  if (!queryEmbedding) {
    return { result: 'Unable to search sessions: embedding unavailable.' };
  }

  // Run check_sessions (old) + search_memory (recent) in true parallel
  const [oldSessions, recentLines] = await Promise.all([
    vectorSearchOldSessions(userId, queryEmbedding, 5),
    getRecentSessionContext(userId, queryEmbedding, 3)
  ]);

  const lines = [];

  for (const s of recentLines) lines.push(s);

  for (const s of oldSessions) {
    const age = Math.floor((Date.now() - s.timestamp) / 86_400_000);
    lines.push(`[Session — ${age}d ago] ${s.text}`);
  }

  return { result: lines.length > 0 ? lines.join('\n\n') : 'No matching sessions found.' };
}

// ── Scheduling ────────────────────────────────────────────────────────────────

async function handleSetReminder(userId, message, timeRelative) {
  const timeDate = parseRelativeTime(timeRelative);
  const reminder = createReminderObject(userId, message, timeDate);
  initializeUserReminders(userId);
  state.reminders[userId].push(reminder);
  await db.saveReminder(userId, reminder);
  scheduleReminder(client, reminder);
  memorySystem.invalidatePersonalDataCache(userId);
  return { result: `${MSG.REMINDER_SET} ${timeDate.toLocaleString()}` };
}

async function handleSetBirthday(userId, month, day, guildId) {
  const birthdayKey  = `${userId}_${month}_${day}`;
  const birthdayData = createBirthdayData(month, day, guildId);
  await db.saveBirthday(birthdayKey, birthdayData);
  memorySystem.invalidatePersonalDataCache(userId);
  return { result: `${MSG.BIRTHDAY_SET} ${month}/${day}` };
}

async function handleSetTimezone(userId, timezone) {
  await db.saveUserTimezone(userId, timezone);
  memorySystem.invalidatePersonalDataCache(userId);
  return { result: `${MSG.TIMEZONE_SET} ${timezone}` };
}

async function handleCheckTimeElapsed(historyId, userId, guildId) {
  const targetId = historyId || guildId || userId;
  try {
    const allHistory = await db.getChatHistory(targetId);
    if (!allHistory) return { result: 'No conversation history found.' };
    const historyArray = [];
    for (const key of Object.keys(allHistory)) historyArray.push(...(allHistory[key] || []));
    if (historyArray.length === 0) return { result: 'No previous messages found.' };
    historyArray.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const lastMsg = historyArray[historyArray.length - 1];
    const diff    = Date.now() - (lastMsg.timestamp || Date.now());
    return { result: `${MSG.TIME_CHECKED} ${formatDuration(diff)}` };
  } catch (error) {
    logger.error('Error checking time elapsed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

async function handleGetMessageTimestamp(userId, guildId, historyId, query) {
  try {
    const targetId = historyId || guildId || userId;
    const { embeddingService } = await import('../../memory/EmbeddingService.js');
    const { findSimilarMemories } = await import('../../database/vectorSearch.js');
    const queryEmbedding = await embeddingService.generateEmbedding(query, 'RETRIEVAL_QUERY');
    if (!queryEmbedding) return { result: 'Could not generate embedding for timestamp search.' };
    const results = await findSimilarMemories(targetId, queryEmbedding, 1);
    if (!results?.length) return { result: 'No matching message found in memory.' };
    const entry = results[0];
    if (!entry.timestamp) return { result: 'Message found but timestamp not recorded.' };
    const date      = new Date(entry.timestamp);
    const formatted = date.toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long',
      day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    });
    const snippet = entry.text ? ` (about: "${entry.text.slice(0, 80)}...")` : '';
    return { result: `That message was sent on: ${formatted}${snippet}` };
  } catch (error) {
    logger.error('Error getting message timestamp', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

function handleGetCurrentDatetime(userId) {
  const timezone = state.userTimezones?.[userId] || 'UTC';
  const now = new Date();
  let formatted, tzLabel;
  try {
    formatted = now.toLocaleString('en-US', {
      timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long',
      day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true, timeZoneName: 'short'
    });
    tzLabel = timezone === 'UTC'
      ? 'UTC (no timezone saved — use /timezone to personalise)'
      : timezone;
  } catch {
    formatted = now.toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZoneName: 'short'
    });
    tzLabel = 'UTC (stored timezone was invalid — please use /timezone to fix it)';
  }
  return { result: `Current date/time: ${formatted} | Timezone used: ${tzLabel}` };
}

// ── GIF ───────────────────────────────────────────────────────────────────────

const GIF_BLOCK_TERMS = new Set([
  'nsfw', 'sexy', 'nude', 'naked', 'porn', 'sex', 'hentai',
  'gore', 'blood', 'dead', 'kill', 'murder', 'shoot', 'slur', 'racist', 'hate'
]);

function isGifBlocked(title, tags) {
  const haystack = [title, ...tags].join(' ').toLowerCase();
  for (const term of GIF_BLOCK_TERMS) {
    if (haystack.includes(term)) return true;
  }
  return false;
}

/**
 * Search for a GIF and store its URL in pendingGif (keyed by historyId).
 * The GIF is sent as a clean image embed by ResponseHandler — no URL in text.
 */
async function handleSearchGif(query, historyId) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) return { result: MSG.GIF_NO_API_KEY };

  try {
    const { data } = await axios.get('https://api.giphy.com/v1/gifs/search', {
      params: { q: query, api_key: apiKey, limit: 5, rating: 'pg', lang: 'en' },
      timeout: 5000
    });

    const results = data?.data;
    if (!results?.length) return { result: MSG.GIF_NO_RESULTS };

    for (const item of results) {
      const title = item.title || '';
      const tags  = item.tags  || [];
      if (isGifBlocked(title, tags)) { logger.debug(`GIF blocked: "${title}"`); continue; }

      // Prefer GIF URL for Discord embed compatibility, fallback to MP4
      const gifUrl = item.images?.fixed_height?.url
        || item.images?.original?.url
        || item.images?.fixed_height?.mp4
        || item.url;
      if (!gifUrl) continue;

      // Store URL for ResponseHandler to send as clean embed image.
      // Do NOT download for vision — giving the model the image triggers narration.
      if (historyId) setPendingGif(historyId, gifUrl);

      return { result: `GIF sent: "${title}". React casually in 1-2 words max — no description, no narration.` };
    }

    return { result: MSG.GIF_NO_RESULTS };
  } catch (error) {
    logger.error('GIF search failed', error);
    return { result: MSG.GIF_API_ERROR };
  }
}

// ── Emojis / stickers ─────────────────────────────────────────────────────────

function handleGetServerEmojis(guildId) {
  if (!guildId) return { result: MSG.NO_GUILD };
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { result: 'Could not access server emoji list.' };
  const emojis = guild.emojis.cache;
  if (!emojis.size) return { result: 'This server has no custom emojis.' };
  const lines = emojis.map(e => {
    const fmt = e.animated ? `<a:${e.name}:${e.id}>` : `<:${e.name}:${e.id}>`;
    return `${e.name}: ${fmt}`;
  });
  return {
    result: [
      `Server has ${emojis.size} custom emoji(s). Use the format exactly as shown:`,
      '', ...lines, '',
      'Copy the format string directly into your message text — Discord renders it.'
    ].join('\n')
  };
}

async function handleGetServerStickers(guildId, historyId, stickerId) {
  if (!guildId) return { result: MSG.NO_GUILD };
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { result: 'Could not access server sticker list.' };
  let stickers;
  try { stickers = await guild.stickers.fetch(); }
  catch { stickers = guild.stickers.cache; }
  if (!stickers.size) return { result: 'This server has no custom stickers.' };
  if (stickerId) {
    const sticker = stickers.get(stickerId);
    if (!sticker) return { result: MSG.STICKER_NOT_FOUND };
    setPendingSticker(historyId, stickerId);
    return { result: `${MSG.STICKER_QUEUED}` };
  }
  const lines = stickers.map(s =>
    `"${s.name}" — ID: ${s.id}${s.description ? ` (${s.description})` : ''}`
  );
  return {
    result: [
      `Server has ${stickers.size} sticker(s):`, '', ...lines, '',
      'To send one, call this tool again with the chosen sticker_id.'
    ].join('\n')
  };
}

// ── Profile ───────────────────────────────────────────────────────────────────

/** Map Discord.js UserFlags enum keys to human-readable badge labels. */
const USER_FLAG_LABELS = Object.freeze({
  Staff:                  '👨‍💼 Discord Staff',
  Partner:                '🤝 Partnered Server Owner',
  Hypesquad:              '🏠 HypeSquad Events Member',
  BugHunterLevel1:        '🐛 Bug Hunter (Level 1)',
  BugHunterLevel2:        '🐛 Bug Hunter (Level 2)',
  HypeSquadOnlineHouse1:  '🏆 HypeSquad Bravery',
  HypeSquadOnlineHouse2:  '🏆 HypeSquad Brilliance',
  HypeSquadOnlineHouse3:  '🏆 HypeSquad Balance',
  PremiumEarlySupporter:  '⭐ Early Nitro Supporter',
  TeamPseudoUser:         '👥 Team Account',
  VerifiedBot:            '✅ Verified Bot',
  VerifiedDeveloper:      '🔧 Early Verified Bot Developer',
  CertifiedModerator:     '🛡️ Discord Certified Moderator',
  ActiveDeveloper:        '🔨 Active Developer',
  Spammer:                '🚫 Flagged as Spammer',
  DisablePremium:         '🔒 Nitro Disabled',
  Quarantined:            '⚠️ Quarantined Account',
});

async function handleCheckProfile(targetUserId, guildId) {
  try {
    // force: true bypasses cache to get the latest avatar/banner data
    const user   = await client.users.fetch(targetUserId, { force: true });
    const isSelf = targetUserId === client.user?.id;

    // ── Global user info ────────────────────────────────────────────────────
    const globalName = user.globalName || user.displayName || user.username;
    const lines = [
      `**${globalName}** (@${user.username})`,
      `🆔 ID: ${user.id}`,
      `🤖 Bot: ${user.bot ? 'Yes' : 'No'}`,
      `📅 Account created: ${fmtDate(user.createdAt)}`,
    ];

    // Avatar — global
    lines.push(`🖼️ Global avatar: ${user.displayAvatarURL({ size: 256, forceStatic: false })}`);

    // Banner (requires force: true fetch so bannerHash is populated)
    if (user.banner) {
      lines.push(`🎨 Banner: ${user.bannerURL({ size: 512 })}`);
    } else if (user.accentColor != null) {
      lines.push(`🎨 Banner colour: #${user.accentColor.toString(16).padStart(6, '0')}`);
    }

    // Avatar decoration (Nitro/special cosmetic)
    if (user.avatarDecoration) {
      lines.push(`✨ Avatar decoration: Yes`);
    }

    // Badges / public flags
    const flagsArray = user.flags?.toArray?.() ?? [];
    if (flagsArray.length > 0) {
      const badgeLabels = flagsArray
        .map(f => USER_FLAG_LABELS[f] ?? f)
        .filter(Boolean);
      if (badgeLabels.length > 0) {
        lines.push(`🏅 Badges: ${badgeLabels.join(' · ')}`);
      }
    }

    // ── Guild-specific info ─────────────────────────────────────────────────
    if (guildId) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        let member;
        try { member = await guild.members.fetch(targetUserId); } catch { /* not in guild */ }

        if (member) {
          // member.displayName is what Discord actually shows for this user in this server:
          // nickname (if set) → globalName → username. Always show it so Lumin knows
          // exactly what name everyone in the server sees for this person.
          lines.push(`📝 Server display name: ${member.displayName}`);

          // If a custom nickname is set, also show it so there's no ambiguity
          if (member.nickname) {
            lines.push(`📛 Server nickname (custom): ${member.nickname}`);
          }

          // Server-specific avatar — shown separately from global avatar
          if (member.avatar) {
            lines.push(`🖼️ Server avatar: ${member.displayAvatarURL({ size: 256, forceStatic: false })}`);
          }

          // Per-server banner (Discord.js ≥ 14.14 — distinct from the global user banner)
          if (member.banner) {
            lines.push(`🎨 Server banner: ${member.bannerURL({ size: 512 })}`);
          }

          lines.push(`📅 Joined server: ${fmtDate(member.joinedAt)}`);

          // Boost info
          if (member.premiumSince) {
            lines.push(`🚀 Server boosting since: ${fmtDate(member.premiumSince)}`);
          }

          // Roles (exclude @everyone), sorted by hierarchy
          const roles = member.roles.cache
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => `${r.name} [ID: ${r.id}]`);
          if (roles.length) {
            const shown   = roles.slice(0, 10);
            const overflow = roles.length > 10 ? ` (+${roles.length - 10} more)` : '';
            lines.push(`🏷️ Roles: ${shown.join(', ')}${overflow}`);
          }

          // ── Presence ──────────────────────────────────────────────────────
          const presence = member.presence;
          if (presence) {
            const STATUS_EMOJI = { online: '🟢', idle: '🌙', dnd: '🔴', offline: '⚫', invisible: '⚫' };
            const statusLabel  = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', offline: 'Offline', invisible: 'Invisible' };
            lines.push(`${STATUS_EMOJI[presence.status] ?? '⚫'} Status: ${statusLabel[presence.status] ?? presence.status}`);

            const activities = presence.activities ?? [];
            for (const act of activities) {
              switch (act.type) {
                case 0: // Playing
                  lines.push([
                    `🎮 Playing: **${act.name}**`,
                    act.details  && ` — ${act.details}`,
                    act.state    && ` (${act.state})`,
                    act.timestamps?.start && ` | started ${fmtDate(act.timestamps.start)}`
                  ].filter(Boolean).join(''));
                  break;
                case 1: // Streaming
                  lines.push(`📺 Streaming: **${act.name}**${act.url ? ` → ${act.url}` : ''}`);
                  break;
                case 2: // Listening
                  lines.push([
                    `🎵 Listening to: **${act.name}**`,
                    act.details  && ` — ${act.details}`,
                    act.state    && ` by ${act.state}`,
                  ].filter(Boolean).join(''));
                  break;
                case 3: // Watching
                  lines.push(`📺 Watching: **${act.name}**`);
                  break;
                case 4: // Custom status
                  {
                    const emojiStr = act.emoji ? `${act.emoji.toString()} ` : '';
                    const text     = act.state || act.name || '';
                    if (emojiStr || text) lines.push(`💬 Custom status: ${emojiStr}${text}`);
                  }
                  break;
                case 5: // Competing
                  lines.push(`🏆 Competing in: **${act.name}**`);
                  break;
              }
            }
          } else if (!isSelf) {
            lines.push(`⚫ Status: offline / not cached (ensure GuildPresences intent is enabled)`);
          }

          // ── Voice state ────────────────────────────────────────────────────
          if (member.voice?.channel) {
            const vc    = member.voice.channel;
            const flags = [
              member.voice.serverDeaf  && '🔇 Server-deafened',
              member.voice.selfDeaf    && '🔇 Self-deafened',
              member.voice.serverMute  && '🔕 Server-muted',
              member.voice.selfMute    && '🔕 Self-muted',
              member.voice.streaming   && '📡 Live stream',
              member.voice.selfVideo   && '📷 Camera on',
            ].filter(Boolean).join(', ');
            lines.push(`🔊 In voice: **${vc.name}** [ID: ${vc.id}]${flags ? ` (${flags})` : ''}`);
          }

        } else {
          lines.push(`ℹ️ This user is not currently a member of this server.`);
        }
      }
    }

    // Split media URLs from context. Model gets a clean summary;
    // avatar/banner only sent if user explicitly asked for pfp/banner.
    const mediaLines = lines.filter(l =>
      l.startsWith('\u{1F5BC}\uFE0F') || (l.startsWith('\u{1F3A8}') && !l.includes('colour'))
    );
    const contextLines = lines.filter(l => !mediaLines.includes(l));

    const cleanContext = contextLines
      .map(l => l.replace(/\s*\[ID:[^\]]+\]/g, ''))
      .join('\n');

    const avatarLine = mediaLines.find(l => l.includes('Global avatar') || l.startsWith('\u{1F5BC}\uFE0F'));
    const avatarUrl  = avatarLine ? avatarLine.split(': ').slice(1).join(': ').trim() : null;
    const bannerLine = mediaLines.find(l => l.includes('Banner') && !l.includes('colour'));
    const bannerUrl  = bannerLine ? bannerLine.split(': ').slice(1).join(': ').trim() : null;

    const resultObj = {
      result: [
        'Profile context below. Give a SHORT natural in-character reply (1-2 sentences max). Do NOT list or dump this data, do NOT paste URLs, do NOT mention role IDs or technical fields. Talk like a friend who casually knows this person.',
        cleanContext,
        avatarUrl ? '[avatar available — ONLY send the URL below if the user explicitly asked for pfp/avatar/picture]' : '',
        bannerUrl ? '[banner available — ONLY send the URL below if the user explicitly asked for banner]' : '',
        avatarUrl ? `_avatar_: ${avatarUrl}` : '',
        bannerUrl ? `_banner_: ${bannerUrl}` : '',
      ].filter(Boolean).join('\n')
    };

    if (avatarUrl) resultObj._profileAvatarUrl = avatarUrl;
    if (bannerUrl) resultObj._profileBannerUrl = bannerUrl;

    return resultObj;
  } catch (error) {
    logger.error('handleCheckProfile failed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function handleCreatePoll(guildId, channelId, question, answersStr, durationHours = 24, allowMultiselect = false) {
  if (!guildId) return { result: MSG.NO_GUILD };

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return { result: 'Cannot create a poll in this channel type.' };

    const answers = answersStr
      .split(',')
      .map(a => a.trim())
      .filter(Boolean)
      .slice(0, 10);

    if (answers.length < 2) return { result: 'A poll needs at least 2 answer options. Separate them with commas.' };

    const duration = Math.max(1, Math.min(168, Math.round(durationHours)));

    await channel.send({
      poll: {
        question:         { text: question.slice(0, 300) },
        answers:          answers.map(a => ({ poll_media: { text: a.slice(0, 55) } })),
        duration,
        allow_multiselect: Boolean(allowMultiselect)
      }
    });

    return { result: `Poll created with ${answers.length} options, running for ${duration}h.` };
  } catch (error) {
    logger.error('handleCreatePoll failed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

// ── DM / server messaging ─────────────────────────────────────────────────────

async function handleSendDm(guildId, targetUserId, content) {
  if (!guildId) return { result: 'send_dm can only be called from a server channel, not DMs.' };

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return { result: 'Could not access the current server.' };

    // Verify target is in this server
    let targetMember;
    try { targetMember = await guild.members.fetch(targetUserId); }
    catch { return { result: 'That user is not a member of this server.' }; }

    const targetUser = await client.users.fetch(targetUserId);
    await targetUser.send(content);

    return { result: `DM sent to ${targetMember.displayName} (@${targetUser.username}).` };
  } catch (error) {
    logger.error('handleSendDm failed', error);
    if (error.code === 50007) return { result: 'Cannot send DM — the user has DMs disabled or has blocked the bot.' };
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

async function handleSendServerMessage(userId, guildId, content, guildName, channelName) {
  if (guildId) return { result: 'send_server_message is only for DM conversations. In a server, just respond normally.' };

  try {
    let targetGuild = null;

    // Find by name if provided
    if (guildName) {
      targetGuild = client.guilds.cache.find(g =>
        g.name.toLowerCase().includes(guildName.toLowerCase())
      );
    }

    // Fallback: first guild where the user is a cached member
    if (!targetGuild) {
      for (const [, guild] of client.guilds.cache) {
        if (guild.members.cache.has(userId)) { targetGuild = guild; break; }
      }
    }

    // Last resort: first guild where the bot can fetch the user
    if (!targetGuild) {
      for (const [, guild] of client.guilds.cache) {
        try {
          await guild.members.fetch(userId);
          targetGuild = guild;
          break;
        } catch { /* not in this guild */ }
      }
    }

    if (!targetGuild) return { result: 'Could not find a mutual server to send the message to. Make sure you and the bot share a server.' };

    // Only send to channels the bot is explicitly allowed in
    const allowedChannels = state.serverSettings[targetGuild.id]?.allowedChannels;
    if (!allowedChannels || allowedChannels.length === 0) {
      return { result: `No allowed channels are configured for ${targetGuild.name}. An admin must set allowed channels before the bot can send messages there.` };
    }

    // Find channel by name within allowed channels only
    let targetChannel = null;
    if (channelName) {
      targetChannel = targetGuild.channels.cache.find(c =>
        allowedChannels.includes(c.id) &&
        c.isTextBased() && c.viewable &&
        c.name.toLowerCase().includes(channelName.toLowerCase())
      );
    }
    // Fallback: first allowed channel
    if (!targetChannel) {
      targetChannel = targetGuild.channels.cache.find(c =>
        allowedChannels.includes(c.id) && c.isTextBased() && c.viewable
      );
    }

    if (!targetChannel) return { result: 'Could not find a matching allowed channel to send the message to. Check the channel name or ask an admin to configure allowed channels.' };

    await targetChannel.send(content);
    return { result: `Message sent to #${targetChannel.name} in ${targetGuild.name}.` };
  } catch (error) {
    logger.error('handleSendServerMessage failed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

// ── Edit / delete ─────────────────────────────────────────────────────────────

async function handleEditMessage(historyId, channelId, newContent, messageId) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { result: 'Could not access the channel.' };

    let targetMessageId = messageId;

    // If no explicit ID given, use the tracked last bot message
    if (!targetMessageId) {
      const lastBot = getLastBotMessage(historyId);
      targetMessageId = lastBot?.messageId;
    }

    if (!targetMessageId) return { result: 'No recent bot message found to edit. Provide a message_id.' };

    const msg = await channel.messages.fetch(targetMessageId).catch(() => null);
    if (!msg) return { result: 'Message not found.' };
    if (msg.author.id !== client.user.id) return { result: 'Can only edit my own messages.' };

    // Edit preserving embeds if the message has them
    if (msg.embeds.length > 0) {
      const { EmbedBuilder } = await import('discord.js');
      const oldEmbed  = msg.embeds[0];
      const newEmbed  = EmbedBuilder.from(oldEmbed).setDescription(newContent);
      await msg.edit({ content: ' ', embeds: [newEmbed] });
    } else {
      await msg.edit({ content: newContent, embeds: [] });
    }

    return { result: 'ok', _silent: true };
  } catch (error) {
    logger.error('handleEditMessage failed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

async function handleDeleteMessage(historyId, channelId, messageId) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { result: 'Could not access the channel.' };

    let targetMessageId = messageId;

    if (!targetMessageId) {
      const lastBot = getLastBotMessage(historyId);
      targetMessageId = lastBot?.messageId;
    }

    if (!targetMessageId) return { result: 'No recent bot message found to delete. Provide a message_id.' };

    const msg = await channel.messages.fetch(targetMessageId).catch(() => null);
    if (!msg) return { result: 'Message not found.' };
    if (msg.author.id !== client.user.id) return { result: 'Can only delete my own messages.' };

    await msg.delete();
    return { result: 'ok', _silent: true };
  } catch (error) {
    logger.error('handleDeleteMessage failed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

// ── Pin / thread / reaction ───────────────────────────────────────────────────

async function handlePinMessage(guildId, channelId, originalMessageId, targetMessageId) {
  if (!guildId) return { result: MSG.NO_GUILD };

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { result: 'Could not access the channel.' };

    const msgId = targetMessageId || originalMessageId;
    if (!msgId) return { result: 'No message ID provided to pin.' };

    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (!msg) return { result: 'Message not found.' };

    await msg.pin();
    return { result: `Message pinned in #${channel.name}.` };
  } catch (error) {
    logger.error('handlePinMessage failed', error);
    if (error.code === 50013) return { result: MSG.NO_PERMISSION + ' Need Manage Messages permission.' };
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

async function handleCreateThread(guildId, channelId, originalMessageId, threadName, startMessageId, autoArchive = 1440) {
  if (!guildId) return { result: MSG.NO_GUILD };

  const VALID_ARCHIVE = [60, 1440, 4320, 10080];
  const archiveDuration = VALID_ARCHIVE.includes(autoArchive) ? autoArchive : 1440;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { result: 'Could not access the channel.' };

    const name = (threadName || 'New Thread').slice(0, 100);

    if (startMessageId) {
      // Thread from a specific message
      const msg = await channel.messages.fetch(startMessageId).catch(() => null);
      if (!msg) return { result: 'Message not found to start thread from.' };
      const thread = await msg.startThread({ name, autoArchiveDuration: archiveDuration });
      return { result: `Thread "${thread.name}" created from message in #${channel.name}.` };
    }

    // Standalone thread (from the original message or channel)
    if (originalMessageId) {
      const msg = await channel.messages.fetch(originalMessageId).catch(() => null);
      if (msg) {
        const thread = await msg.startThread({ name, autoArchiveDuration: archiveDuration });
        return { result: `Thread "${thread.name}" created.` };
      }
    }

    // Fallback: create thread directly on channel
    // Forum channels (type 15) require a starter message — handle separately
    if (channel.type === 15) {
      const thread = await channel.threads.create({
        name,
        autoArchiveDuration: archiveDuration,
        message: { content: name }  // forum channels require a starter message
      });
      return { result: `Thread "${thread.name}" created in forum channel #${channel.name}.` };
    }

    const thread = await channel.threads.create({ name, autoArchiveDuration: archiveDuration });
    return { result: `Thread "${thread.name}" created in #${channel.name}.` };
  } catch (error) {
    logger.error('handleCreateThread failed', error);
    if (error.code === 50013) return { result: MSG.NO_PERMISSION + ' Need Manage Threads permission.' };
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

async function handleAddReaction(channelId, originalMessageId, emoji, targetMessageId) {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { result: 'Could not access the channel.' };

    const msgId = targetMessageId || originalMessageId;
    if (!msgId) return { result: 'No message ID to react to.' };

    const msg = await channel.messages.fetch(msgId).catch(() => null);
    if (!msg) return { result: 'Message not found.' };

    await msg.react(emoji);
    return { result: `Reacted with ${emoji}.` };
  } catch (error) {
    logger.error('handleAddReaction failed', error);
    if (error.code === 10014) return { result: 'Unknown emoji — make sure the emoji format is correct.' };
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

// ── Server / channel info ─────────────────────────────────────────────────────

async function handleGetServerInfo(guildId) {
  if (!guildId) return { result: MSG.NO_GUILD };

  try {
    const guild = await client.guilds.fetch({ guild: guildId, withCounts: true }).catch(() => client.guilds.cache.get(guildId));
    if (!guild) return { result: 'Could not access server information.' };

    const channelCounts = { text: 0, voice: 0, category: 0, stage: 0, forum: 0, announcement: 0 };
    for (const [, ch] of guild.channels.cache) {
      if (ch.type === 0)  channelCounts.text++;
      else if (ch.type === 2) channelCounts.voice++;
      else if (ch.type === 4) channelCounts.category++;
      else if (ch.type === 5) channelCounts.announcement++;
      else if (ch.type === 13) channelCounts.stage++;
      else if (ch.type === 15) channelCounts.forum++;
    }

    const boostTier = ['None', 'Level 1', 'Level 2', 'Level 3'][guild.premiumTier] || 'Unknown';

    const lines = [
      `**${guild.name}**`,
      `🆔 ID: ${guild.id}`,
      `📅 Created: ${fmtDate(guild.createdAt)}`,
      `👑 Owner ID: ${guild.ownerId}`,
      ``,
      `👥 Members: ${guild.memberCount ?? guild.members.cache.size}`,
      `📢 Channels: ${channelCounts.text} text, ${channelCounts.voice} voice, ${channelCounts.stage} stage, ${channelCounts.forum} forum, ${channelCounts.announcement} announcements`,
      `🏷️ Roles: ${guild.roles.cache.size}`,
      `😀 Emojis: ${guild.emojis.cache.size}`,
      `🎭 Stickers: ${guild.stickers.cache.size}`,
      ``,
      `🚀 Boost tier: ${boostTier} (${guild.premiumSubscriptionCount ?? 0} boosts)`,
      `🔒 Verification: ${['None', 'Low', 'Medium', 'High', 'Very High'][guild.verificationLevel] ?? 'Unknown'}`,
      `📍 Region: ${guild.preferredLocale}`,
    ];

    if (guild.description) lines.push(`📝 Description: ${guild.description}`);
    if (guild.iconURL()) lines.push(`🖼️ Icon: ${guild.iconURL({ size: 256 })}`);

    // Top roles
    const topRoles = guild.roles.cache
      .filter(r => r.id !== guild.id && !r.managed)
      .sort((a, b) => b.position - a.position)
      .first(8);
    if (topRoles?.size) {
      lines.push(``, `🏅 Top roles: ${[...topRoles.values()].map(r => r.name).join(', ')}`);
    }

    return { result: lines.join('\n') };
  } catch (error) {
    logger.error('handleGetServerInfo failed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

async function handleGetChannelInfo(currentChannelId, targetChannelId) {
  const VOICE_MEMBER_LIMIT = 500;
  const channelId = targetChannelId || currentChannelId;
  if (!channelId) return { result: 'No channel ID available.' };

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) return { result: 'Channel not found.' };

    const TYPE_NAMES = {
      0: 'Text', 2: 'Voice', 4: 'Category', 5: 'Announcement',
      10: 'Announcement Thread', 11: 'Public Thread', 12: 'Private Thread',
      13: 'Stage', 14: 'Directory', 15: 'Forum', 16: 'Media'
    };

    const lines = [
      `**#${channel.name}**`,
      `🆔 ID: ${channel.id}`,
      `📌 Type: ${TYPE_NAMES[channel.type] ?? channel.type}`,
    ];

    if (channel.parent) lines.push(`📁 Category: ${channel.parent.name}`);
    if (channel.topic)  lines.push(`📝 Topic: ${channel.topic}`);

    // Text-specific
    if (channel.nsfw !== undefined) lines.push(`🔞 NSFW: ${channel.nsfw ? 'Yes' : 'No'}`);
    if (channel.rateLimitPerUser)   lines.push(`🐢 Slowmode: ${channel.rateLimitPerUser}s`);

    // Voice / stage specific
    if (channel.bitrate)     lines.push(`🎙️ Bitrate: ${Math.round(channel.bitrate / 1000)}kbps`);
    if (channel.userLimit != null) lines.push(`👥 User limit: ${channel.userLimit || 'Unlimited'}`);

    // Voice members
    if (channel.members) {
      const memberCount = channel.members.size;
      if (memberCount > 0) {
        lines.push(``);
        if (memberCount > VOICE_MEMBER_LIMIT) {
          lines.push(`🔊 Connected: ${VOICE_MEMBER_LIMIT}+ users`);
        } else {
          const memberList = [...channel.members.values()]
            .map(m => `${m.displayName}${m.voice?.selfMute ? ' 🔕' : ''}${m.voice?.selfDeaf ? ' 🔇' : ''}${m.voice?.streaming ? ' 📡' : ''}`)
            .join(', ');
          lines.push(`🔊 Connected (${memberCount}): ${memberList}`);
        }
      } else {
        lines.push(`🔊 Connected: empty`);
      }
    }

    // Stage-specific
    if (channel.type === 13 && channel.stageInstance) {
      const si = channel.stageInstance;
      lines.push(`🎤 Stage topic: ${si.topic ?? 'None'}`);
    }

    if (channel.createdAt) lines.push(`📅 Created: ${fmtDate(channel.createdAt)}`);

    return { result: lines.join('\n') };
  } catch (error) {
    logger.error('handleGetChannelInfo failed', error);
    return { result: `${MSG.OPERATION_FAILED}: ${error.message}` };
  }
}

// ── Meme (Multi-source: meme-api.com → Reddit JSON → GIPHY) ─────────────────
//
// SOURCE FALLBACK ORDER (all within a single function-call turn):
//   SOURCE 1: meme-api.com     — free third-party wrapper; different IP path than
//                                 direct Reddit, so survives Reddit IP bans
//   SOURCE 2: Reddit JSON API  — direct reddit.com fetch (5 internal strategies)
//   SOURCE 3: GIPHY GIF API    — meme GIFs; requires GIPHY_API_KEY env var
//
// Each source is tried independently. The first one that returns a usable image
// wins. This means a Reddit IP ban no longer burns all function-call turns —
// meme-api.com picks up the slack, and GIPHY ensures something always sends.

/**
 * Rolling seen-URL deduplication cache.
 * Prevents the bot from sending the same meme twice in the same conversation.
 * Key: historyId (conversation key). Value: string[] of already-sent URLs (newest last).
 */
const RECENT_MEMES  = new Map();
const RECENT_WINDOW = 15; // block repeats within last 15 memes

function markMemeSeen(key, url) {
  if (!key) return;
  if (!RECENT_MEMES.has(key)) RECENT_MEMES.set(key, []);
  const list = RECENT_MEMES.get(key);
  list.push(url);
  if (list.length > RECENT_WINDOW) list.shift();
}

function isMemeSeen(key, url) {
  return RECENT_MEMES.get(key)?.includes(url) ?? false;
}

/**
 * Deliver a meme — queue the URL for Discord attachment and return the result string.
 *
 * @param {{ url: string, title: string, source: string }} meme
 * @param {string|null} historyId
 * @param {string}      seenKey
 * @returns {{ result: string }}
 */
function deliverMeme(meme, historyId, seenKey) {
  markMemeSeen(seenKey, meme.url);
  if (historyId) setPendingGif(historyId, meme.url);
  const title = (meme.title || 'Meme').slice(0, 200);
  return { result: `Meme sent from ${meme.source}: "${title}". React casually in 1-2 words max — no description, no narration.` };
}

// ── SOURCE 1: meme-api.com ────────────────────────────────────────────────────
//
// Free public API, no auth required. Backed by Reddit but proxied through a
// separate service — survives Reddit IP bans because the request originates from
// meme-api.com's servers, not ours.
// Docs: https://github.com/D3vd/Meme_Api
//
// Endpoints used:
//   GET https://meme-api.com/gimme/{subreddit}/{count} → up to 50 posts from a sub
//   GET https://meme-api.com/gimme/{count}             → random posts from popular subs
//
// HOW DYNAMIC TOPIC SUPPORT WORKS:
//   meme-api.com has no search endpoint — it only fetches by subreddit name.
//   To support any free-text topic ("gojo", "breaking bad", "dark humor", etc.),
//   buildSubredditCandidates() generates multiple subreddit name guesses from the
//   topic string, then fetchFromMemeApi() fires them all in parallel and returns
//   the first batch that has valid images. This gives broad coverage without
//   needing a search API.
//
//   Candidate generation strategy (in priority order):
//     1. Explicit subreddit override (passed directly)
//     2. Known-good mappings from TOPIC_TO_SUBS (curated list, multiple per topic)
//     3. Topic string itself as a subreddit name (e.g. "gojo" → r/gojo)
//     4. Topic words joined without spaces in TitleCase (e.g. "dark humor" → r/DarkHumor)
//     5. Topic + "Memes" suffix (e.g. "minecraft" → r/MinecraftMemes)
//     6. Topic + "Humor" suffix (e.g. "programming" → r/ProgrammingHumor)
//     7. Each individual word in a multi-word topic (e.g. "breaking bad" → r/breakingbad)

const MEME_API_TIMEOUT = 8000;
const MEME_API_BATCH   = 15; // posts per subreddit fetch

/**
 * Topic → known meme subreddits mapping.
 * Multiple subs per topic — all are tried in parallel so the best available wins.
 * Keys are lowercase; matching is substring-based so "jujutsu" hits "jujutsu kaisen".
 */
const TOPIC_TO_SUBS = {
  // ── Anime / Manga ────────────────────────────────────────────────────────
  anime:          ['Animemes', 'anime_irl', 'AnimeMeme'],
  manga:          ['Animemes', 'manga'],
  gojo:           ['JujutsuKaisen', 'Animemes'],
  jujutsu:        ['JujutsuKaisen', 'Animemes'],
  naruto:         ['Naruto', 'dankruto', 'Animemes'],
  onepiece:       ['OnePieceMemes', 'OnePiece', 'Animemes'],
  'one piece':    ['OnePieceMemes', 'OnePiece', 'Animemes'],
  dragonball:     ['Dragonballsuper', 'dbz', 'Animemes'],
  'dragon ball':  ['Dragonballsuper', 'dbz', 'Animemes'],
  demonslayer:    ['KimetsuNoYaiba', 'Animemes'],
  'demon slayer': ['KimetsuNoYaiba', 'Animemes'],
  aot:            ['ShingekiNoKyojin', 'ANRime', 'Animemes'],
  'attack on titan': ['ShingekiNoKyojin', 'ANRime', 'Animemes'],
  mha:            ['BokuNoHeroAcademia', 'Animemes'],
  'my hero':      ['BokuNoHeroAcademia', 'Animemes'],
  haikyuu:        ['haikyuu', 'Animemes'],
  bleach:         ['bleach', 'Animemes'],
  hunter:         ['HunterXHunter', 'Animemes'],
  'death note':   ['deathnote', 'Animemes'],
  're:zero':        ['Re_Zero', 'Animemes'],
  isekai:         ['Animemes', 'IsekaiMemes'],
  waifu:          ['Animemes', 'waifuparent'],

  // ── Gaming ────────────────────────────────────────────────────────────────
  gaming:         ['gaming', 'pcmasterrace', 'gamingmemes'],
  minecraft:      ['MinecraftMemes', 'Minecraft'],
  fortnite:       ['FortNiteBR', 'fortnitebr'],
  valorant:       ['VALORANT', 'ValorantMemes'],
  league:         ['leagueoflegends', 'GrandmaFoundTheLeague'],
  'league of legends': ['leagueoflegends', 'GrandmaFoundTheLeague'],
  genshin:        ['Genshin_Impact', 'GenshinImpactMemes'],
  overwatch:      ['Overwatch', 'OWConsole'],
  csgo:           ['GlobalOffensive', 'csgomemes'],
  cs2:            ['GlobalOffensive', 'csgomemes'],
  roblox:         ['roblox', 'ROBLOXMemes'],
  pokemon:        ['pokemon', 'pokemonmemes'],
  zelda:          ['zelda', 'truezelda'],
  'mario':        ['Mario', 'mariokart'],
  'among us':     ['AmongUs', 'AmongUsMemes'],
  elden:          ['Eldenring'],
  'dark souls':   ['darksouls', 'darksouls3'],
  skyrim:         ['skyrim', 'ElderScrolls'],
  apex:           ['apexlegends', 'ApexOutlands'],
  pubg:           ['PUBATTLEGROUNDS'],
  'call of duty': ['CODMobile', 'modernwarfare'],
  cod:            ['CODMobile', 'modernwarfare'],
  rpg:            ['gaming', 'rpg'],
  fps:            ['gaming', 'FPS'],
  steam:          ['steam', 'pcmasterrace'],
  pcmr:           ['pcmasterrace'],

  // ── TV Shows / Movies ────────────────────────────────────────────────────
  'breaking bad': ['breakingbad', 'okbuddychicanery'],
  'walter white': ['breakingbad', 'okbuddychicanery'],
  heisenberg:     ['breakingbad', 'okbuddychicanery'],
  'better call saul': ['betterCallSaul'],
  'the office':   ['DunderMifflin', 'theoffice'],
  'parks and rec': ['PandR', 'parksandrecreation'],
  'arrested development': ['arresteddevelopment'],
  'it crowd':     ['TheITCrowd'],
  'spongebob':    ['SquaredCircle', 'BikiniBottomTwitter'],
  sponge:         ['BikiniBottomTwitter'],
  'family guy':   ['familyguy', 'FamilyGuyMemes'],
  'south park':   ['southpark'],
  simpsons:       ['TheSimpsons', 'simpsonsshitposting'],
  'futurama':     ['futurama'],
  rickandmorty:   ['rickandmorty'],
  'rick and morty': ['rickandmorty'],
  witcher:        ['witcher', 'wiedzmin'],
  'game of thrones': ['gameofthrones', 'freefolk'],
  got:            ['freefolk', 'gameofthrones'],
  'house of dragon': ['HouseOfTheDragon'],
  'stranger things': ['StrangerThings'],
  marvel:         ['marvelstudios', 'Marvel'],
  avengers:       ['marvelstudios', 'Marvel'],
  'star wars':    ['StarWars', 'PrequelMemes'],
  'prequel':      ['PrequelMemes'],
  'lord of the rings': ['lotrmemes', 'lotr'],
  lotr:           ['lotrmemes', 'lotr'],
  batman:         ['batman', 'DC_Cinematic'],
  superman:       ['superman', 'DC_Cinematic'],
  'iron man':     ['marvelstudios', 'Marvel'],
  joker:          ['Joker', 'batman'],
  'harry potter': ['harrypotter', 'HarryPotterMemes'],

  // ── Programming / Tech ────────────────────────────────────────────────────
  programming:    ['ProgrammerHumor', 'programmingmemes'],
  coding:         ['ProgrammerHumor', 'programmingmemes'],
  developer:      ['ProgrammerHumor', 'webdev'],
  javascript:     ['ProgrammerHumor', 'javascript'],
  python:         ['ProgrammerHumor', 'Python'],
  java:           ['ProgrammerHumor', 'java'],
  css:            ['ProgrammerHumor', 'webdev'],
  html:           ['ProgrammerHumor', 'webdev'],
  linux:          ['linuxmasterrace', 'linux'],
  windows:        ['ProgrammerHumor', 'windows'],
  ai:             ['ProgrammerHumor', 'artificial'],
  chatgpt:        ['ProgrammerHumor', 'ChatGPT'],
  tech:           ['ProgrammerHumor', 'technology'],
  hacker:         ['ProgrammerHumor', 'hacking'],
  git:            ['ProgrammerHumor'],
  stackoverflow:  ['ProgrammerHumor'],
  bug:            ['ProgrammerHumor'],

  // ── Animals ────────────────────────────────────────────────────────────────
  cat:            ['catmemes', 'cats', 'CatsAreAssholes'],
  cats:           ['catmemes', 'cats', 'CatsAreAssholes'],
  dog:            ['dogmemes', 'dogpictures', 'rarepuppers'],
  dogs:           ['dogmemes', 'dogpictures', 'rarepuppers'],
  doge:           ['dogecoin', 'doge'],
  shiba:          ['shiba', 'doge'],
  bird:           ['birdsarentreal', 'whatsthisbird'],
  duck:           ['quityourbullshit'],
  animal:         ['AnimalsBeingDerps', 'AnimalsBeingBros'],

  // ── Moods / Vibes ─────────────────────────────────────────────────────────
  dark:           ['darkhumor', 'edgymemes'],
  'dark humor':   ['darkhumor', 'edgymemes'],
  wholesome:      ['wholesomememes', 'MadeMeSmile'],
  relatable:      ['me_irl', 'AdviceAnimals'],
  depression:     ['me_irl', 'doomer', '2meirl4meirl'],
  sad:            ['me_irl', '2meirl4meirl'],
  anxiety:        ['me_irl', 'AnxietyMemes'],
  monday:         ['Mondaymemes', 'me_irl'],
  work:           ['WorkMemes', 'antiwork'],
  school:         ['school', 'teenagers'],
  college:        ['college', 'premed'],
  exam:           ['school', 'college'],
  study:          ['school', 'college'],

  // ── Misc / Culture ────────────────────────────────────────────────────────
  'gen z':        ['GenZ', 'teenagers'],
  boomer:         ['BoomersBeingFools', 'OkBoomer'],
  millennial:     ['me_irl', 'AdviceAnimals'],
  karen:          ['IDontWorkHereLady', 'EntitledPeople'],
  npc:            ['NPCMemes', 'youngpeopleyoutube'],
  sigma:          ['SigmaGrindset', 'Bropranos'],
  ohio:           ['MemeVideos', 'OhioMemes'],
  rizz:           ['teenagers', 'GenZ'],
  'skill issue':    ['gaming', 'SkillshotMemes'],
  'touch grass':    ['me_irl', 'teenagers'],
  gigachad:       ['GigaChadMemes', 'memes'],
  mewing:         ['teenagers', 'GenZ'],
  brainrot:       ['teenagers', 'GenZ'],
  music:          ['AdviceAnimals', 'music'],
  math:           ['mathmemes', 'learnmath'],
  physics:        ['physicsmemes'],
  history:        ['HistoryMemes', 'historymemes'],
  philosophy:     ['PhilosophyMemes'],
  food:           ['food_irl', 'me_irl'],
  pizza:          ['pizza', 'food_irl'],
  coffee:         ['me_irl', 'coffee'],
  gym:            ['gymmemes', 'fitness'],
  fitness:        ['gymrats', 'gymmemes'],
  sleep:          ['me_irl', '2meirl4meirl'],
  money:          ['wallstreetbets', 'personalfinance'],
  crypto:         ['CryptoCurrency', 'Bitcoin'],
  bitcoin:        ['Bitcoin', 'CryptoCurrency'],
  stocks:         ['wallstreetbets'],
  wsb:            ['wallstreetbets'],
};

/**
 * Convert a TitleCase or space-separated string into PascalCase.
 * e.g. "dark humor" → "DarkHumor", "breaking bad" → "BreakingBad"
 */
function toPascalCase(str) {
  return str.split(/[\s_-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

/**
 * Build an ordered list of subreddit name candidates for a given topic.
 * Each candidate is tried via meme-api.com/gimme/{sub}/15 in parallel.
 * Deduplication is applied so the same sub isn't tried twice.
 *
 * @param {string|null} topic
 * @param {string|null} explicitSub
 * @returns {string[]} ordered candidate subreddit names (no duplicates)
 */
function buildSubredditCandidates(topic, explicitSub) {
  const candidates = [];
  const seen       = new Set();

  function add(sub) {
    if (!sub || seen.has(sub.toLowerCase())) return;
    seen.add(sub.toLowerCase());
    candidates.push(sub);
  }

  // 1. Explicit override always goes first
  if (explicitSub?.trim()) add(explicitSub.trim());

  if (topic?.trim()) {
    const t = topic.trim();
    const tLower = t.toLowerCase();

    // 2. Curated known-good mappings (all matching entries)
    for (const [key, subs] of Object.entries(TOPIC_TO_SUBS)) {
      if (tLower.includes(key)) subs.forEach(add);
    }

    // 3. Topic itself as-is (handles things like "ProgrammerHumor" or "gojo")
    add(t.replace(/\s+/g, ''));

    // 4. PascalCase (e.g. "dark humor" → "DarkHumor")
    add(toPascalCase(t));

    // 5. Topic + "Memes" (e.g. "minecraft" → "MinecraftMemes")
    add(toPascalCase(t) + 'Memes');

    // 6. Topic + "Humor" (e.g. "programming" → "ProgrammingHumor")
    add(toPascalCase(t) + 'Humor');

    // 7. Each individual word for multi-word topics
    const words = tLower.split(/\s+/).filter(w => w.length > 2);
    words.forEach(w => add(w));
    words.forEach(w => add(w + 'memes'));
  }

  return candidates;
}

/**
 * Normalise a meme-api.com item into the standard internal meme shape.
 * @param {object} item
 * @returns {{ url: string, title: string, source: string, over_18: boolean, spoiler: boolean }}
 */
function normaliseMemeApiItem(item) {
  return {
    url:     item.url     ?? '',
    title:   item.title   ?? 'Meme',
    source:  `r/${item.subreddit ?? 'meme-api'}`,
    over_18: item.nsfw    ?? false,
    spoiler: item.spoiler ?? false,
  };
}

/**
 * Fetch one batch of posts from a single subreddit via meme-api.com.
 * Returns an empty array on any error so callers can safely filter.
 *
 * @param {string} sub
 * @returns {Promise<object[]>}
 */
async function fetchMemeApiSubreddit(sub) {
  try {
    const url = `https://meme-api.com/gimme/${encodeURIComponent(sub)}/${MEME_API_BATCH}`;
    const { data } = await axios.get(url, { timeout: MEME_API_TIMEOUT });
    return (data?.memes ?? (data?.url ? [data] : [])).map(normaliseMemeApiItem);
  } catch {
    return [];
  }
}

/**
 * Check whether a normalised meme-api item is a safe, displayable image.
 * @param {object} item
 * @param {string} seenKey
 */
function isValidMemeApiItem(item, seenKey) {
  return (
    item.url &&
    !item.over_18 &&
    !item.spoiler &&
    !isMemeSeen(seenKey, item.url) &&
    /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(item.url)
  );
}

/**
 * Fetch a meme from meme-api.com for any free-text topic.
 *
 * Flow:
 *   1. Build subreddit candidates from the topic (curated map + generated variants)
 *   2. Fire all candidates in parallel via meme-api.com/gimme/{sub}/15
 *   3. Return the first valid, unseen image found across all results
 *   4. If no candidates matched, fall back to a generic random batch
 *
 * @param {string|null} topic
 * @param {string|null} subreddit
 * @param {string}      seenKey
 * @returns {Promise<{ url: string, title: string, source: string }|null>}
 */
async function fetchFromMemeApi(topic, subreddit, seenKey) {
  try {
    const candidates = buildSubredditCandidates(topic, subreddit);

    if (candidates.length > 0) {
      // Fire all candidates in parallel; cap at 8 to avoid hammering the API
      const batches = await Promise.allSettled(
        candidates.slice(0, 8).map(sub => fetchMemeApiSubreddit(sub))
      );

      // Flatten all results and pick the first valid unseen one
      for (const batch of batches) {
        if (batch.status !== 'fulfilled') continue;
        const valid = batch.value.filter(item => isValidMemeApiItem(item, seenKey));
        if (valid.length) return valid[0];
      }
    }

    // Generic fallback — random batch from meme-api's default popular subs
    const { data } = await axios.get(`https://meme-api.com/gimme/20`, { timeout: MEME_API_TIMEOUT });
    const items = (data?.memes ?? []).map(normaliseMemeApiItem);
    const valid  = items.filter(item => isValidMemeApiItem(item, seenKey));
    return valid[0] ?? null;

  } catch (err) {
    logger.warn('meme-api.com fetch failed', err.message);
    return null;
  }
}

// ── SOURCE 2: Reddit JSON API ─────────────────────────────────────────────────

const REDDIT_HEADERS = {
  'User-Agent': `${SYSTEM_AGENT_CALLSIGN}Bot/4.0 (Discord Bot; open-source)`,
  'Accept':     'application/json',
};
const REDDIT_TIMEOUT = 9000;

async function discoverSubreddits(topic, limit = 8) {
  try {
    const url = `https://www.reddit.com/subreddits/search.json`
      + `?q=${encodeURIComponent(topic)}&limit=${limit}&raw_json=1`;
    const { data } = await axios.get(url, { headers: REDDIT_HEADERS, timeout: REDDIT_TIMEOUT });
    return (data?.data?.children ?? [])
      .map(c => c.data)
      .filter(s => !s.over18 && (s.subscribers ?? 0) > 1000)
      .sort((a, b) => (b.subscribers ?? 0) - (a.subscribers ?? 0))
      .map(s => s.display_name);
  } catch {
    return [];
  }
}

async function searchRedditPosts(query, { sort = 'relevance', time = 'month', limit = 50 } = {}) {
  const url = `https://www.reddit.com/search.json`
    + `?q=${encodeURIComponent(query)}&type=link&sort=${sort}&t=${time}&limit=${limit}&raw_json=1`;
  const { data } = await axios.get(url, { headers: REDDIT_HEADERS, timeout: REDDIT_TIMEOUT });
  return (data?.data?.children ?? []).map(c => c.data);
}

async function fetchSubredditPosts(sub, { sort = 'hot', time = 'week', limit = 50, query = null } = {}) {
  let url;
  if (query) {
    url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.json`
      + `?q=${encodeURIComponent(query)}&restrict_sr=on&sort=top&t=month&limit=${limit}&raw_json=1`;
  } else {
    const timeParam = sort === 'top' ? `&t=${time}` : '';
    url = `https://www.reddit.com/r/${encodeURIComponent(sub)}/${sort}.json`
      + `?limit=${limit}${timeParam}&raw_json=1`;
  }
  const { data } = await axios.get(url, { headers: REDDIT_HEADERS, timeout: REDDIT_TIMEOUT });
  return (data?.data?.children ?? []).map(c => c.data);
}

function isValidRedditMemePost(post) {
  if (!post) return false;
  if (post.over_18 || post.spoiler || post.is_video) return false;
  if (post.score < -10) return false;
  if (post.post_hint === 'image') return true;
  if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(post.url ?? '')) return true;
  if (/^https?:\/\/i\.redd\.it\//i.test(post.url ?? '')) return true;
  return false;
}

function scoreRedditPost(post) {
  const ratio   = post.upvote_ratio ?? 0.5;
  const score   = Math.max(post.score ?? 0, 1);
  const ageSecs = Date.now() / 1000 - (post.created_utc ?? 0);
  const ageDays = ageSecs / 86400;
  let freshness;
  if      (ageDays < 1)  freshness = 1.6;
  else if (ageDays < 3)  freshness = 1.3;
  else if (ageDays < 7)  freshness = 1.0;
  else if (ageDays < 30) freshness = 0.75;
  else                   freshness = 0.5;
  return ratio * Math.log10(score + 1) * freshness;
}

function rankRedditPosts(posts, seenKey) {
  return posts
    .filter(p => isValidRedditMemePost(p) && !isMemeSeen(seenKey, p.url))
    .sort((a, b) => scoreRedditPost(b) - scoreRedditPost(a));
}

/**
 * Normalise a Reddit post to the standard internal meme shape.
 */
function normaliseRedditPost(post) {
  return {
    url:    post.url,
    title:  post.title ?? 'Meme',
    source: `r/${post.subreddit ?? '?'}`,
  };
}

/**
 * All 5 Reddit strategies wrapped as a single source.
 * Returns null (instead of throwing) if Reddit is unreachable, rate-limited, or IP-banned —
 * so the caller can fall through to GIPHY without burning extra function-call turns.
 *
 * @param {string|null} topic
 * @param {string|null} subreddit
 * @param {string}      sort
 * @param {string}      seenKey
 * @returns {Promise<{ url: string, title: string, source: string }|null>}
 */
async function fetchFromReddit(topic, subreddit, sort, seenKey) {
  try {
    const searchTopic = topic?.trim() || null;

    // Strategy 0: explicit subreddit
    if (subreddit?.trim()) {
      const sub  = subreddit.trim();
      const opts = searchTopic ? { query: searchTopic, limit: 50 } : { sort, limit: 75 };
      const posts  = await fetchSubredditPosts(sub, opts).catch(() => []);
      const ranked = rankRedditPosts(posts, seenKey);
      if (ranked.length) return normaliseRedditPost(ranked[0]);
    }

    // Strategy 1: sitewide "{topic} meme" search
    if (searchTopic) {
      const posts  = await searchRedditPosts(`${searchTopic} meme`, { sort: 'relevance', time: 'month', limit: 75 }).catch(() => []);
      const ranked = rankRedditPosts(posts, seenKey);
      if (ranked.length) return normaliseRedditPost(ranked[0]);
    }

    // Strategy 2: dynamic subreddit discovery → hot posts
    if (searchTopic) {
      const subs     = await discoverSubreddits(searchTopic, 8);
      const allPosts = [];
      await Promise.allSettled(
        subs.slice(0, 5).map(sub =>
          fetchSubredditPosts(sub, { sort, limit: 50 }).then(p => allPosts.push(...p)).catch(() => {})
        )
      );
      const ranked = rankRedditPosts(allPosts, seenKey);
      if (ranked.length) return normaliseRedditPost(ranked[0]);
    }

    // Strategy 3: within discovered subs — topic keyword search
    if (searchTopic) {
      const subs     = await discoverSubreddits(searchTopic, 8);
      const allPosts = [];
      await Promise.allSettled(
        subs.slice(0, 5).map(sub =>
          fetchSubredditPosts(sub, { query: searchTopic, limit: 50 }).then(p => allPosts.push(...p)).catch(() => {})
        )
      );
      const ranked = rankRedditPosts(allPosts, seenKey);
      if (ranked.length) return normaliseRedditPost(ranked[0]);
    }

    // Strategy 4: broader sitewide — raw topic, top/week
    if (searchTopic) {
      const posts  = await searchRedditPosts(searchTopic, { sort: 'top', time: 'week', limit: 100 }).catch(() => []);
      const ranked = rankRedditPosts(posts, seenKey);
      if (ranked.length) return normaliseRedditPost(ranked[0]);
    }

    // Strategy 5: fallback — well-known meme subs
    const fallbackPosts = [];
    await Promise.allSettled(
      ['memes', 'dankmemes', 'me_irl', 'wholesomememes'].map(sub =>
        fetchSubredditPosts(sub, { sort: 'hot', limit: 50 }).then(p => fallbackPosts.push(...p)).catch(() => {})
      )
    );
    const fallbackRanked = rankRedditPosts(fallbackPosts, seenKey);
    if (fallbackRanked.length) return normaliseRedditPost(fallbackRanked[0]);

    return null; // all Reddit strategies exhausted

  } catch (err) {
    logger.warn('Reddit meme fetch failed', err.message);
    return null;
  }
}


// ── SOURCE 3: GIPHY GIF API ───────────────────────────────────────────────────
//
// Already used for stickers. Reused here for meme GIF fallback.
// Requires GIPHY_API_KEY env var.

/**
 * @param {string|null} topic
 * @param {string}      seenKey
 * @returns {Promise<{ url: string, title: string, source: string }|null>}
 */
async function fetchFromGiphyMeme(topic, seenKey) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) return null;

  try {
    const query = topic ? `${topic} meme` : 'funny meme';
    const { data } = await axios.get('https://api.giphy.com/v1/gifs/search', {
      params: { q: query, api_key: apiKey, limit: 20, rating: 'pg-13', lang: 'en' },
      timeout: 6000,
    });

    const results = data?.data ?? [];
    for (const item of results) {
      const title = item.title || query;
      const tags  = item.tags || [];
      if (isGifBlocked(title, tags)) continue;

      const gifUrl =
        item.images?.fixed_height?.url ||
        item.images?.original?.url     ||
        item.images?.downsized?.url;
      if (!gifUrl || isMemeSeen(seenKey, gifUrl)) continue;
      return { url: gifUrl, title, source: 'GIPHY' };
    }
    return null;

  } catch (err) {
    logger.warn('GIPHY meme fetch failed', err.message);
    return null;
  }
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────

/**
 * Fetch a meme using a multi-source fallback chain.
 *
 * Source priority (first hit wins, all within a single function-call turn):
 *   1. meme-api.com  — Reddit proxy; different IP path, survives Reddit bans
 *   2. Reddit JSON   — direct fetch with 5 internal strategies
 *   3. GIPHY API     — meme GIFs (set GIPHY_API_KEY to enable)
 *
 * Because every source catches its own errors and returns null on failure,
 * a full Reddit IP ban no longer causes the AI to retry the tool call
 * multiple times — meme-api.com or GIPHY pick up the slack immediately.
 *
 * @param {string|null} historyId  - conversation dedup key
 * @param {string|null} subreddit  - explicit subreddit override (Reddit sources only)
 * @param {string|null} topic      - free-text topic/search term
 * @param {string}      sort       - "hot" | "top" | "new" | "rising" (Reddit sources)
 */
async function handleFetchMeme(historyId, subreddit, topic, sort = 'hot') {
  const seenKey = historyId ?? 'global';

  // ── Source 1: meme-api.com ────────────────────────────────────────────────
  const memeApiResult = await fetchFromMemeApi(topic, subreddit, seenKey);
  if (memeApiResult) return deliverMeme(memeApiResult, historyId, seenKey);

  // ── Source 2: Reddit JSON API ─────────────────────────────────────────────
  const redditResult = await fetchFromReddit(topic, subreddit, sort, seenKey);
  if (redditResult) return deliverMeme(redditResult, historyId, seenKey);

  // ── Source 3: GIPHY (if GIPHY_API_KEY is set) ─────────────────────────────
  const giphyResult = await fetchFromGiphyMeme(topic, seenKey);
  if (giphyResult) return deliverMeme(giphyResult, historyId, seenKey);

  logger.warn('handleFetchMeme: all sources exhausted', { topic, subreddit });
  return { result: 'No suitable meme found across all sources. Try a different topic or subreddit.' };
}

// ── GIPHY sticker ─────────────────────────────────────────────────────────────

async function handleSearchGiphySticker(query, historyId) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) return { result: 'GIPHY sticker search unavailable: GIPHY_API_KEY is not configured.' };

  try {
    const { data } = await axios.get('https://api.giphy.com/v1/stickers/search', {
      params: { q: query, api_key: apiKey, limit: 5, rating: 'pg', lang: 'en' },
      timeout: 5000
    });

    const results = data?.data;
    if (!results?.length) return { result: 'No sticker found for that search.' };

    for (const item of results) {
      const title = item.title || '';
      const tags  = item.tags  || [];
      if (isGifBlocked(title, tags)) { logger.debug(`Sticker blocked: "${title}"`); continue; }

      // Prefer GIF URL for Discord embed compatibility, fallback to MP4
      const stickerUrl =
        item.images?.fixed_height?.url ||
        item.images?.original?.url     ||
        item.images?.fixed_height?.mp4;
      if (!stickerUrl) continue;

      if (historyId) setPendingGif(historyId, stickerUrl);

      return { result: `Sticker found: "${title}"` };
    }

    return { result: 'No suitable sticker found for that search.' };
  } catch (error) {
    logger.error('handleSearchGiphySticker failed', error);
    return { result: `Sticker search failed: ${error.message}` };
  }
}

// ── Google search (Gemma-only fallback) ──────────────────────────────────────

async function handleGoogleSearch(query) {
  try {
    const { MODELS, GEMMA_DEFAULT_MODEL, getGenerationConfig, safetySettings } = await import('../config.js');

    const searchFallbackChain = [
      MODELS['gemini-3.1-flash-lite'] ?? 'gemini-3.1-flash-lite',
      MODELS[GEMMA_DEFAULT_MODEL]     ?? 'gemma-4-26b-a4b-it'
    ];

    const systemInstruction = [
      'You are a search assistant. Perform a web search and provide accurate, current results.',
      'Structure your answer as: a brief summary, key findings, and source URLs.',
      'Be concise and factual. Current date: ' + new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    ].join(' ');

    let lastError;
    for (const searchModel of searchFallbackChain) {
      try {
        const request = {
          model:    searchModel,
          contents: [{ role: 'user', parts: [{ text: `Search the web for: ${query}` }] }],
          config: {
            ...getGenerationConfig(searchModel),
            safetySettings,
            tools: [{ googleSearch: {} }],
            systemInstruction
          }
        };

        const result = await genAI.models.generateContent(request);
        const text   = result.candidates?.[0]?.content?.parts
          ?.filter(p => p.text)
          ?.map(p => p.text)
          ?.join('') || 'No results found.';

        return { result: text };
      } catch (err) {
        logger.warn(`handleGoogleSearch: model ${searchModel} failed — ${err.message}`);
        lastError = err;
      }
    }

    return { result: `Search failed: ${lastError?.message ?? 'unknown error'}` };
  } catch (error) {
    logger.error('handleGoogleSearch failed', error);
    return { result: `Search failed: ${error.message}` };
  }
}

// ============================================================================
// FAN-OUT EXECUTOR
// ============================================================================

/**
 * Execute all function calls produced by the model in a single turn, in parallel.
 *
 * @param {object[]}    calls      - array of { name, args } OR { functionCall: { name, args } }
 * @param {string}      userId
 * @param {string|null} guildId
 * @param {string|null} historyId
 * @param {string|null} channelId
 * @param {string|null} originalMessageId  - ID of the triggering user message
 * @param {string}      [modelName]        - Active model name (used to guard Gemma-only tools)
 * @returns {Promise<object[]>}
 */
export async function executeFunctionCalls(calls, userId, guildId, historyId, channelId = null, originalMessageId = null, modelName = '') {
  return Promise.all(
    calls.map(async (raw) => {
      const call = raw?.functionCall ?? raw;
      const args = call.args || {};
      let response = {};

      try {
        switch (call.name) {
          // ── Memory ────────────────────────────────────────────────────────
          case FUNCTION_NAMES.MANAGE_MEMORY:
            response = await handleManageMemory(userId, args.action, args.info, guildId);
            break;
          case FUNCTION_NAMES.MANAGE_SERVER_FACT:
            response = await handleManageServerFact(guildId, args.action, args.info, args.category);
            break;
          case FUNCTION_NAMES.SEARCH_MEMORY:
            response = await handleSearchMemory(userId, guildId, historyId, args.query);
            break;
          case FUNCTION_NAMES.CHECK_SESSIONS:
            response = await handleCheckSessions(userId, guildId, historyId, args.query);
            break;

          // ── Scheduling ────────────────────────────────────────────────────
          case FUNCTION_NAMES.SET_REMINDER:
            response = await handleSetReminder(userId, args.message, args.time_relative);
            break;
          case FUNCTION_NAMES.SET_BIRTHDAY:
            response = await handleSetBirthday(userId, args.month, args.day, guildId);
            break;
          case FUNCTION_NAMES.SET_TIMEZONE:
            response = await handleSetTimezone(userId, args.timezone);
            break;
          case FUNCTION_NAMES.CHECK_TIME:
            response = await handleCheckTimeElapsed(historyId, userId, guildId);
            break;
          case FUNCTION_NAMES.GET_TIMESTAMP:
            response = await handleGetMessageTimestamp(userId, guildId, historyId, args.query);
            break;
          case FUNCTION_NAMES.GET_CURRENT_DATETIME:
            response = handleGetCurrentDatetime(userId);
            break;

          // ── Media ─────────────────────────────────────────────────────────
          case FUNCTION_NAMES.SEARCH_GIF:
            response = await handleSearchGif(args.query, historyId);
            break;
          case FUNCTION_NAMES.GET_SERVER_EMOJIS:
            response = handleGetServerEmojis(guildId);
            break;
          case FUNCTION_NAMES.GET_SERVER_STICKERS:
            response = await handleGetServerStickers(guildId, historyId, args.sticker_id ?? null);
            break;

          // ── Meme / GIPHY sticker ────────────────────────────────────────────
          case FUNCTION_NAMES.FETCH_MEME:
            response = await handleFetchMeme(historyId, args.subreddit ?? null, args.topic ?? null, args.sort ?? 'hot');
            break;
          case FUNCTION_NAMES.SEARCH_GIPHY_STICKER:
            response = await handleSearchGiphySticker(args.query, historyId);
            break;

          // ── Discord actions ────────────────────────────────────────────────
          case FUNCTION_NAMES.CHECK_PROFILE:
            response = await handleCheckProfile(args.user_id, guildId);
            break;
          case FUNCTION_NAMES.CREATE_POLL:
            response = await handleCreatePoll(guildId, channelId, args.question, args.answers, args.duration_hours, args.allow_multiselect);
            break;
          case FUNCTION_NAMES.SEND_DM:
            response = await handleSendDm(guildId, args.user_id, args.content);
            break;
          case FUNCTION_NAMES.SEND_SERVER_MSG:
            response = await handleSendServerMessage(userId, guildId, args.content, args.guild_name, args.channel_name);
            break;
          case FUNCTION_NAMES.EDIT_MESSAGE:
            response = await handleEditMessage(historyId, channelId, args.new_content, args.message_id ?? null);
            break;
          case FUNCTION_NAMES.DELETE_MESSAGE:
            response = await handleDeleteMessage(historyId, channelId, args.message_id ?? null);
            break;
          case FUNCTION_NAMES.PIN_MESSAGE:
            response = await handlePinMessage(guildId, channelId, originalMessageId, args.message_id ?? null);
            break;
          case FUNCTION_NAMES.CREATE_THREAD:
            response = await handleCreateThread(guildId, channelId, originalMessageId, args.name, args.message_id ?? null, args.auto_archive ?? 1440);
            break;
          case FUNCTION_NAMES.ADD_REACTION:
            response = await handleAddReaction(channelId, originalMessageId, args.emoji, args.message_id ?? null);
            break;

          // ── Info ──────────────────────────────────────────────────────────
          case FUNCTION_NAMES.GET_SERVER_INFO:
            response = await handleGetServerInfo(guildId);
            break;
          case FUNCTION_NAMES.GET_CHANNEL_INFO:
            response = await handleGetChannelInfo(channelId, args.channel_id ?? null);
            break;

          // ── Gemma search ──────────────────────────────────────────────────
          case FUNCTION_NAMES.GOOGLE_SEARCH:
            if (!isGemmaModel(modelName)) {
              response = { result: 'google_search is only available when using a Gemma model. Gemini models use native web search instead.' };
            } else {
              response = await handleGoogleSearch(args.query);
            }
            break;

          // ── Ignore ────────────────────────────────────────────────────────
          case FUNCTION_NAMES.IGNORE_USER:
            response = { _silent: true };
            break;

          default:
            logger.warn(`Unknown function call received: ${call.name}`);
            response = { error: `Unknown function: ${call.name}` };
        }
      } catch (error) {
        logger.error(`Error executing function "${call.name}"`, error);
        response = { error: `${MSG.OPERATION_FAILED}: ${error.message}` };
      }

      // ── Inline image extraction ────────────────────────────────────────────
      // Some handlers (e.g. fetch_meme) attach base64 image data to the response
      // object so Gemini can actually *see* the media before writing its reply.
      // We extract those private fields here, strip them from the JSON response
      // (they're not serialisable as part of the functionResponse), and add them
      // as separate inlineData parts in the same user turn.
      const extraParts = [];
      if (response._inlineImageData) {
        extraParts.push({
          inlineData: {
            mimeType: response._inlineImageMime || 'image/jpeg',
            data:     response._inlineImageData
          }
        });
        // Clean private fields so they don't appear in the model's function result JSON
        const { _inlineImageData, _inlineImageMime, ...cleanResponse } = response;
        response = cleanResponse;
      }

      // Return as an array of parts so results.flat() works cleanly downstream
      return [{ functionResponse: { name: call.name, response } }, ...extraParts];
    })
  ).then(results => results.flat());
}
