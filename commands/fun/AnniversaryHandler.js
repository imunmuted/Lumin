/**
 * @fileoverview /details command — display bot's server anniversary and conversation stats.
 * @module commands/fun/AnniversaryHandler
 */

import {
  MessageFlags,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder
} from 'discord.js';

import { state }  from '../../managers/BotManager.js';
import * as db    from '../../database/index.js';
import { Logger } from '../../core/Logger.js';
import { SYSTEM_AGENT_CALLSIGN } from '../../modules/config.js';

const logger = Logger.get('AnniversaryHandler');

// ============================================================================
// COMMAND DEFINITION
// ============================================================================

export const anniversaryCommand = {
  name:        'details',
  description: "View bot's server details and conversation statistics"
};

// ============================================================================
// CONSTANTS
// ============================================================================

const ACCENT_COLOR     = 0xE53935;
const IS_COMPONENTS_V2 = 1 << 15;

const VERIFICATION_LABELS = Object.freeze({
  0: 'None',
  1: 'Low — verified email required',
  2: 'Medium — registered 5+ min',
  3: 'High — member 10+ min',
  4: 'Highest — phone verified'
});

const CONTENT_FILTER_LABELS = Object.freeze({
  0: 'Disabled',
  1: 'Members without roles',
  2: 'All members'
});

const BOOST_TIER_LABELS = Object.freeze({
  0: 'None',
  1: 'Tier 1',
  2: 'Tier 2',
  3: 'Tier 3'
});

const FEATURE_LABELS = Object.freeze({
  COMMUNITY:                        'Community',
  PARTNERED:                        'Partnered',
  VERIFIED:                         'Verified',
  DISCOVERABLE:                     'Discoverable',
  MONETIZATION_ENABLED:             'Monetization',
  NEWS:                             'News Channels',
  WELCOME_SCREEN_ENABLED:           'Welcome Screen',
  INVITE_SPLASH:                    'Invite Splash',
  VANITY_URL:                       'Vanity URL',
  ANIMATED_ICON:                    'Animated Icon',
  BANNER:                           'Banner',
  THREADS_ENABLED:                  'Threads',
  MEMBER_VERIFICATION_GATE_ENABLED: 'Member Screening'
});

// ============================================================================
// HELPERS
// ============================================================================

/** Discord absolute + relative timestamp string. */
function ts(date) {
  const unix = Math.floor(date.getTime() / 1000);
  return `<t:${unix}:D>`;
}

/** Add a separator + text section to a container. */
function addSection(container, content) {
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content));
}

// ============================================================================
// HANDLER
// ============================================================================

/**
 * Show how long the bot has been in the server and key conversation statistics.
 * @param {import('discord.js').CommandInteraction} interaction
 */
export async function handleAnniversaryCommand(interaction) {
  if (!interaction.guild) {
    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('**Server Only**\nThis command can only be used in servers.')
    );
    return interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2 });
  }

  // Defer since we make DB calls
  await interaction.deferReply();

  try {
    const guild = interaction.guild;

    // ── Fetch owner username (no ping/mention) ───────────────────────────────
    let ownerName = `ID: ${guild.ownerId}`;
    try {
      const owner = await interaction.client.users.fetch(guild.ownerId);
      ownerName = owner.username;
    } catch { /* fallback to raw ID */ }

    // ── Bot membership duration ──────────────────────────────────────────────
    const botMember = guild.members.cache.get(interaction.client.user.id);
    const joinDate  = botMember?.joinedAt ?? new Date();
    const now       = Date.now();

    const daysSince     = Math.floor((now - joinDate.getTime()) / 86_400_000);
    const yearsSince    = Math.floor(daysSince / 365);
    const remainingDays = daysSince % 365;
    const monthsSince   = Math.floor(remainingDays / 30);
    const finalDays     = remainingDays % 30;

    const durationParts = [];
    if (yearsSince > 0)  durationParts.push(`${yearsSince} year${yearsSince  !== 1 ? 's' : ''}`);
    if (monthsSince > 0) durationParts.push(`${monthsSince} month${monthsSince !== 1 ? 's' : ''}`);
    if (finalDays > 0 || durationParts.length === 0)
      durationParts.push(`${finalDays} day${finalDays !== 1 ? 's' : ''}`);
    const timeDisplay = durationParts.join(', ');

    // ── Member counts ────────────────────────────────────────────────────────
    const totalMembers = guild.memberCount;
    const cachedBots   = guild.members.cache.filter(m => m.user.bot).size;
    const cachedHumans = guild.members.cache.filter(m => !m.user.bot).size;
    const memberDetail = guild.members.cache.size >= totalMembers
      ? `${cachedHumans.toLocaleString()} humans · ${cachedBots.toLocaleString()} bots`
      : `~${cachedHumans.toLocaleString()} humans · ~${cachedBots.toLocaleString()} bots (partial cache)`;

    // ── Guild features ───────────────────────────────────────────────────────
    const activeFeatures = (guild.features ?? [])
      .filter(f => FEATURE_LABELS[f])
      .map(f => FEATURE_LABELS[f])
      .join('  ·  ') || 'None';

    // ── Server icon + banner ─────────────────────────────────────────────────
    const iconURL   = guild.iconURL({ size: 512, extension: 'png' });
    const bannerURL = guild.bannerURL({ size: 1024, extension: 'png' });

    // ── Parallel DB fetches ──────────────────────────────────────────────────
    const [dbHistory, serverFacts, indexedCounts] = await Promise.all([
      db.getChatHistory(guild.id).catch(() => null),
      db.getServerFacts(guild.id).catch(() => []),
      db.getIndexedCounts().catch(() => [])
    ]);

    // ── All-time conversation stats ──────────────────────────────────────────
    // Session cache is authoritative if it has been loaded this session
    // (it contains the DB baseline + any new unsaved messages).
    // Otherwise fall back to the DB snapshot for all-time historical data.
    const guildHistory = (
      state.chatHistories?.[guild.id] &&
      Object.keys(state.chatHistories[guild.id]).length > 0
    ) ? state.chatHistories[guild.id] : (dbHistory ?? {});

    let totalMessages      = 0;
    let userMessages       = 0;
    let botMessages        = 0;
    const activeChannels   = new Set();
    const channelMsgCounts = {};
    const uniqueUsers      = new Set();
    let firstMessageTs     = Infinity;
    let lastMessageTs      = 0;

    for (const [channelId, messages] of Object.entries(guildHistory)) {
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        totalMessages++;
        if (msg.role === 'user') {
          userMessages++;
          activeChannels.add(channelId);
          channelMsgCounts[channelId] = (channelMsgCounts[channelId] ?? 0) + 1;
          if (msg.userId) uniqueUsers.add(msg.userId);
          if (msg.timestamp) {
            if (msg.timestamp < firstMessageTs) firstMessageTs = msg.timestamp;
            if (msg.timestamp > lastMessageTs)  lastMessageTs  = msg.timestamp;
          }
        } else if (msg.role === 'assistant') {
          botMessages++;
        }
      }
    }

    const mostActiveChannel = Object.entries(channelMsgCounts)
      .sort(([, a], [, b]) => b - a)[0];
    const avgPerDay = daysSince > 0 ? (userMessages / daysSince).toFixed(1) : '0';

    // ── Memory index stats ───────────────────────────────────────────────────
    const indexedEntry  = indexedCounts.find(e => e.historyId === guild.id);
    const indexedTotal  = indexedEntry?.count ?? 0;
    const factsCount    = serverFacts.length;

    // ── Feature states ───────────────────────────────────────────────────────
    // Last digest (DigestHandler stores under userDigests with key `server_${guildId}`)
    const lastDigest = state.serverDigests?.[guild.id]
      ?? state.userDigests?.[`server_${guild.id}`];

    // Realive: keyed directly by guildId
    const realiveActive = state.realive?.[guild.id]?.enabled ?? false;
    const realiveInterval = state.realive?.[guild.id]?.intervalHours ?? null;

    // Roulette: keyed by channelId but carries guildId
    const rouletteActive = Object.values(state.roulette ?? {})
      .filter(cfg => cfg.guildId === guild.id && cfg.active).length;

    // Daily quotes: keyed by quoteKey but carries guildId
    const quotesActive = Object.values(state.dailyQuotes ?? {})
      .filter(q => q.guildId === guild.id && q.active).length;

    // ── Build container ──────────────────────────────────────────────────────
    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);

    // — Visual header: prefer banner, fall back to server icon ——
    const headerImageURL = bannerURL ?? iconURL;
    if (headerImageURL) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(
          new MediaGalleryItemBuilder().setURL(headerImageURL)
        )
      );
    }

    // — Section 1: Overview ——
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `# ${guild.name}\n` +
        (guild.description ? `*${guild.description}*\n\n` : '\n') +
        `> 🆔 **ID** — \`${guild.id}\`\n` +
        `> 📅 **Founded** — ${ts(guild.createdAt)}\n` +
        `> 🌐 **Locale** — \`${guild.preferredLocale}\``
      )
    );

    // — Section 2: Community ——
    addSection(container,
      `**👥 Community**\n\n` +
      `> 🧑‍🤝‍🧑 **Members** — \`${totalMembers.toLocaleString()}\`  —  ${memberDetail}\n` +
      `> 👑 **Owner** — ${ownerName}\n` +
      `> 🚀 **Boosts** — ${BOOST_TIER_LABELS[guild.premiumTier] ?? 'None'}  ·  \`${guild.premiumSubscriptionCount ?? 0}\` boost${guild.premiumSubscriptionCount !== 1 ? 's' : ''}`
    );

    // — Section 3: Security ——
    addSection(container,
      `**🔒 Security**\n\n` +
      `> 🛡️ **Verification** — ${VERIFICATION_LABELS[guild.verificationLevel] ?? guild.verificationLevel}\n` +
      `> 🔍 **Content Filter** — ${CONTENT_FILTER_LABELS[guild.explicitContentFilter] ?? guild.explicitContentFilter}\n` +
      `> 🔞 **NSFW Level** — \`${guild.nsfwLevel}\``
    );

    // — Section 4: Features ——
    if (activeFeatures !== 'None') {
      addSection(container,
        `**✨ Server Features**\n\n` +
        `> ${activeFeatures}`
      );
    }

    // — Section 6: Agent — All-Time Conversation Stats ——
    const firstActivityLine = firstMessageTs !== Infinity
      ? `\n> 🏁 **First Message** — ${ts(new Date(firstMessageTs))}`
      : '';
    const lastActivityLine = lastMessageTs > 0
      ? `\n> 🕐 **Last Activity** — ${ts(new Date(lastMessageTs))}`
      : '';
    const uniqueChattersLine = uniqueUsers.size > 0
      ? `\n> 👥 **Unique Chatters** — \`${uniqueUsers.size.toLocaleString()}\``
      : '';
    const topChannelLine = mostActiveChannel && activeChannels.size > 0
      ? `\n> 🏆 **Most Active** — <#${mostActiveChannel[0]}> · \`${mostActiveChannel[1].toLocaleString()}\` messages`
      : '';

    addSection(container,
      `**💬 ${SYSTEM_AGENT_CALLSIGN} — Conversation History**\n\n` +
      `> 📅 **Joined** — ${ts(joinDate)}\n` +
      `> ⏳ **Time Together** — ${timeDisplay}  (\`${daysSince}\` days)\n` +
      `> 📨 **User Messages** — \`${userMessages.toLocaleString()}\`\n` +
      `> 🤖 **${SYSTEM_AGENT_CALLSIGN} Messages** — \`${botMessages.toLocaleString()}\`\n` +
      `> 📡 **Active Channels** — \`${activeChannels.size}\`` +
      uniqueChattersLine +
      `\n> 📊 **Avg / Day** — \`${avgPerDay}\`` +
      firstActivityLine +
      lastActivityLine +
      topChannelLine
    );

    // — Section 7: Agent — Features & Memory ——
    const hasFeatureData = indexedTotal > 0 || factsCount > 0 || lastDigest
      || realiveActive || rouletteActive > 0 || quotesActive > 0;

    if (hasFeatureData) {
      const digestLine = lastDigest
        ? `\n> 📰 **Last Digest** — ${ts(new Date(lastDigest.timestamp))}  ·  \`${lastDigest.messageCount}\` messages`
        : '';
      const reliveLine = realiveActive && realiveInterval
        ? `\n> 🔄 **Realive** — Active  (every \`${realiveInterval}h\`)`
        : realiveActive
          ? `\n> 🔄 **Realive** — Active`
          : '';
      const rouletteLine = rouletteActive > 0
        ? `\n> 🎲 **Roulette** — \`${rouletteActive}\` active channel${rouletteActive !== 1 ? 's' : ''}`
        : '';
      const quotesLine = quotesActive > 0
        ? `\n> 💭 **Daily Quotes** — \`${quotesActive}\` schedule${quotesActive !== 1 ? 's' : ''}`
        : '';

      addSection(container,
        `**🧠 ${SYSTEM_AGENT_CALLSIGN} — Features & Memory**\n\n` +
        `> 🗂️ **Indexed Messages** — \`${indexedTotal.toLocaleString()}\`\n` +
        `> 📌 **Server Facts** — \`${factsCount}\`` +
        digestLine +
        reliveLine +
        rouletteLine +
        quotesLine
      );
    }

    // — Footer subtext ——
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Conversation counts reflect all stored history. Indexed messages are those analyzed for memory recall.`
      )
    );

    await interaction.editReply({ components: [container], flags: IS_COMPONENTS_V2 });

  } catch (error) {
    logger.error('handleAnniversaryCommand failed', error);
    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('**Error**\nFailed to retrieve server details. Please try again later.')
    );
    await interaction.editReply({ components: [container], flags: IS_COMPONENTS_V2 });
  }
}
