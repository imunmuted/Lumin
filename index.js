/**
 * @fileoverview Discord Bot Entry Point — event routing and lifecycle management.
 * @version 4.0.0
 * @module index
 */

import {
  MessageFlags,
  ChannelType,
  PermissionsBitField,
  ActivityType,
  REST,
  Routes
} from 'discord.js';
import { createServer } from 'http';
import express from 'express';

import config from './config.js';
import { mountDashboard, isGlobalLockdown, saveRuntimeConfig } from './dashboard/server.js';
import {
  client,
  token,
  initialize,
  saveStateToFile,
  state,
  TEMP_DIR,
  initializeBlacklistForGuild,
  BOT_CONFIG,
  DEFAULT_USER_SETTINGS,
  requestQueues,   // ← direct import; avoids going through state getter
  getDailyMessageStats,
} from './managers/BotManager.js';

import { Logger }       from './core/Logger.js';
import { Embeds }       from './modules/shared/embedBuilder.js';
import { cleanTemp, startPeriodicCleanup } from './modules/shared/tempFileManager.js';

import { processUserQueue }               from './modules/message/MessageProcessor.js';
import {
  handleButtonInteraction,
  handleSelectMenuInteraction,
  handleModalSubmit,
  showMainSettings
} from './modules/settings/SettingsRouter.js';
import { commands }                       from './commands.js';
import {
  initializeScheduledTasks,
  handleCommandInteraction   as handleNewCommands,
  handleSelectMenuInteraction as handleNewSelectMenus,
  handleModalSubmission      as handleNewModals,
  handleButtonInteraction    as handleNewButtons,
  processMessageRoulette
} from './commands/index.js';
import { MAX_QUEUE_DEPTH_PER_USER, RAM_MEDIA_SUSPEND_THRESHOLD_MB } from './modules/config.js';
import { scheduleDailyDigestJob } from './commands/summary/SessionSummaryJob.js';
import { WEEKLY_SUMMARY_ENABLED }    from './modules/config.js';
import { telemetryWatchdog }          from './core/TelemetryWatchdogDaemon.js';

const logger = Logger.get('Index');

// ============================================================================
// CONSTANTS
// ============================================================================

/** System message type IDs — bot should never respond to these. */
const IGNORED_MESSAGE_TYPES = Object.freeze(new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 18, 20, 21, 22, 23, 24, 25,
  26, 27, 28, 29, 30, 31, 36, 37, 38, 39, 46
]));

// Queue depth limit is set in modules/config.js → MAX_QUEUE_DEPTH_PER_USER
const MAX_USER_QUEUE_SIZE = MAX_QUEUE_DEPTH_PER_USER;

const EXPRESS_CONFIG = Object.freeze({
  PORT:               process.env.PORT || 3000,
  HEALTH_CHECK_PATH:  '/health',
  STATUS_PATH:        '/'
});

// ============================================================================
// INITIALIZATION
// ============================================================================

initialize().catch(error => {
  logger.critical('Critical initialization error', error);
  process.exit(1);
});

// ============================================================================
// EXPRESS HEALTH SERVER
// ============================================================================

const app        = express();
const httpServer = createServer(app);

app.get(EXPRESS_CONFIG.STATUS_PATH, (_req, res) => {
  const telemetry = telemetryWatchdog.getTelemetry();
  res.json({
    status:        'online',
    project:       'Helium',
    bot:           client.user?.tag || 'Starting…',
    uptime:        process.uptime(),
    timestamp:     new Date().toISOString(),
    telemetry,
    dailyMessages: getDailyMessageStats()
  });
});

app.get(EXPRESS_CONFIG.HEALTH_CHECK_PATH, (_req, res) => {
  const healthy = client.isReady() && client.ws.status === 0;
  const msgStats = getDailyMessageStats();
  const telemetry = telemetryWatchdog.getTelemetry();
  res.status(healthy ? 200 : 503).json({
    status:        healthy ? 'healthy' : 'degraded',
    ready:         client.isReady(),
    wsStatus:      client.ws.status,
    timestamp:     new Date().toISOString(),
    telemetry,
    dailyMessages: msgStats
  });
});

httpServer.listen(EXPRESS_CONFIG.PORT, () => {
  logger.info(`Express server running on port ${EXPRESS_CONFIG.PORT}`);
});

// Mount admin dashboard at /dashboard on the same port
mountDashboard(app, httpServer);

// ============================================================================
// TEMP FILE CLEANUP
// ============================================================================

// Immediate startup clean + hourly periodic cleanup via shared tempFileManager.
cleanTemp().catch(() => {});
startPeriodicCleanup(3_600_000, 3_600_000);

// ============================================================================
// ACTIVITY ROTATION
// ============================================================================

const activities = config.activities.map(activity => ({
  name: activity.name,
  type: ActivityType[activity.type]
}));

let activityIndex = 0;

function updateActivity() {
  if (!client.user) return;
  try {
    client.user.setPresence({
      activities: [activities[activityIndex]],
      status:     'idle'
    });
    logger.debug(`Activity set to: ${activities[activityIndex].name}`);
  } catch (error) {
    logger.error('Error updating activity', error);
  }
}

function rotateActivity() {
  activityIndex = (activityIndex + 1) % activities.length;
  updateActivity();
}

// ============================================================================
// BOT EVENTS
// ============================================================================

/**
 * 'clientReady' is the correct event name in Discord.js v14+.
 * 'ready' is deprecated and will be removed in v15.
 */
client.once('clientReady', async () => {
  logger.info(`Logged in as ${client.user.tag}`);

  // Register global slash commands.
  const rest = new REST().setToken(token);
  try {
    logger.info('Refreshing application (/) commands…');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    logger.info('Slash commands refreshed successfully');
  } catch (error) {
    logger.error('Error refreshing commands', error);
  }

  updateActivity();
  setInterval(rotateActivity, 86_400_000);

  try {
    initializeScheduledTasks(client);
    logger.info('Scheduled tasks initialized');
  } catch (error) {
    logger.error('Error initializing scheduled tasks', error);
  }

  // Weekly user context summary job — fires every Sunday at 02:00 UTC
  try {
    scheduleDailyDigestJob();
    logger.info('Daily session digest job scheduled');
  } catch (error) {
    logger.error('Failed to schedule daily digest job', error);
  }

  // ── Periodic GC nudge ─────────────────────────────────────────────────
  // --expose-gc is already in package.json. Fires every 30 min but only
  // calls gc() when heap is actually above 80%, so it's a no-op most of
  // the time and only kicks in when we need it.
  if (typeof global.gc === 'function') {
    setInterval(() => {
      const { heapUsed, heapTotal } = process.memoryUsage();
      if (heapUsed / heapTotal > 0.80) {
        global.gc();
        logger.debug(`GC nudge fired — heap was ${Math.round(heapUsed / 1_048_576)}MB / ${Math.round(heapTotal / 1_048_576)}MB`);
      }
    }, 30 * 60 * 1_000);
    logger.info('GC nudge scheduler active (fires when heap > 80%)');
  }
});

/** Fires when the bot joins a new server. */
client.on('guildCreate', async (guild) => {
  try {
    logger.info(`Joined new guild: ${guild.name} (${guild.id})`);

    const channel = guild.channels.cache.find(
      ch =>
        ch.type === ChannelType.GuildText &&
        ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
    );

    if (channel) {
      await channel.send(`🎉 Thanks for adding me to **${guild.name}**! Use \`/settings\` to configure me.`);
    }
  } catch (error) {
    logger.error('Error sending welcome message', error);
  }
});

/** Main message handler. */
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot)                          return;
    if (message.content.startsWith('!'))             return;
    if (IGNORED_MESSAGE_TYPES.has(message.type))     return;

    // ── Global lockdown: silently drop all chat messages ─────────────────
    if (isGlobalLockdown()) return;

    const isDM       = message.channel.type === ChannelType.DM;
    const guildId    = message.guild?.id;
    const channelId  = message.channelId;
    const userId     = message.author.id;

    if (guildId) {
      initializeBlacklistForGuild(guildId);

      if (state.blacklistedUsers[guildId]?.includes(userId)) return;

      const allowedChannels = state.serverSettings[guildId]?.allowedChannels;
      if (allowedChannels?.length > 0 && !allowedChannels.includes(channelId)) return;
    }

    const userSettings      = state.userSettings[userId]    || {};
    const serverSettings    = guildId ? (state.serverSettings[guildId] || {}) : {};
    const effectiveSettings = serverSettings.overrideUserSettings ? serverSettings : userSettings;
    const continuousReply   = effectiveSettings.continuousReply ?? DEFAULT_USER_SETTINGS.continuousReply;
    const channelContinuous = state.continuousReplyChannels?.[channelId] || false;

    const shouldRespond = (
      (isDM   && BOT_CONFIG.WORK_IN_DMS && (continuousReply || message.mentions.users.has(client.user.id))) ||
      (guildId && message.mentions.users.has(client.user.id))                                               ||
      (guildId && (channelContinuous || continuousReply))                                                   ||
      state.alwaysRespondChannels[channelId]                                                                ||
      state.activeUsersInChannels[channelId]?.[userId]
    );

    if (!shouldRespond) {
      processMessageRoulette(message);
      return;
    }

    if (!requestQueues.has(userId)) {
      requestQueues.set(userId, { queue: [], isProcessing: false });
    }

    const userQueueData = requestQueues.get(userId);

    if (userQueueData.queue.length >= MAX_USER_QUEUE_SIZE) {
      await message.reply({
        embeds: [Embeds.queueFull(MAX_USER_QUEUE_SIZE)],
        flags:  MessageFlags.Ephemeral
      });
      return;
    }

    userQueueData.queue.push(message);

    if (!userQueueData.isProcessing) {
      processUserQueue(userId);
    }

    processMessageRoulette(message);

  } catch (error) {
    logger.error('Error processing message', error);
  }
});

/** Routes all interaction types to the correct handler. */
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommandInteraction(interaction);

    } else if (interaction.isButton()) {
      await handleNewButtons(interaction);
      if (!interaction.replied && !interaction.deferred) {
        await handleButtonInteraction(interaction);
      }

    } else if (interaction.isModalSubmit()) {
      await handleNewModals(interaction);
      if (!interaction.replied && !interaction.deferred) {
        await handleModalSubmit(interaction);
      }

    } else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
      await handleNewSelectMenus(interaction);
      if (!interaction.replied && !interaction.deferred) {
        await handleSelectMenuInteraction(interaction);
      }
    }
  } catch (error) {
    logger.error('Critical interaction error', error);

    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          embeds: [Embeds.error('Unexpected Error', 'An unexpected error occurred.')],
          flags:  MessageFlags.Ephemeral
        });
      }
    } catch { /* unknown interaction — swallow */ }
  }
});

client.on('error', (error) => logger.error('Discord client error', error));
client.on('warn',  (warn)  => logger.warn(`Discord client warning: ${warn}`));
// Note: 'disconnect' and 'reconnecting' events do not exist in discord.js v14+.
// Reconnection is handled internally by the library.

// ============================================================================
// COMMAND ROUTER
// ============================================================================

/**
 * Route slash commands to their handlers.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function handleCommandInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;

  // ── Global lockdown: block all slash commands with a warning ─────────────
  if (isGlobalLockdown()) {
    try {
      const { EmbedBuilder, MessageFlags } = await import('discord.js');
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(0xEF4444)
            .setTitle('🔒 Bot is Under Lockdown')
            .setDescription('All bot functions are temporarily disabled.\nPlease try again later.')
            .setFooter({ text: 'Lockdown is controlled by bot administrators.' })
        ],
        flags: MessageFlags.Ephemeral,
      });
    } catch { /* already replied or unknown interaction */ }
    return;
  }

  const commandHandlers = {
    settings: async (i) => {
      await showMainSettings(i, false);
    },
    search:      handleNewCommands,
    birthday:    handleNewCommands,
    reminder:    handleNewCommands,
    quote:       handleNewCommands,
    reaction:    handleNewCommands,
    details:     handleNewCommands,
    digest:      handleNewCommands,
    starter:     handleNewCommands,
    compliment:  handleNewCommands,
    game:        handleNewCommands,
    timezone:    handleNewCommands,
    summary:     handleNewCommands,
    schedule:    handleNewCommands
  };

  const handler = commandHandlers[interaction.commandName];

  if (!handler) {
    logger.warn(`Unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await handler(interaction);
  } catch (error) {
    logger.error(`Error in command /${interaction.commandName}`, error);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [Embeds.error('Command Failed', 'Failed to execute this command.')],
        flags:  MessageFlags.Ephemeral
      }).catch(() => {});
    }
  }
}

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

/**
 * Graceful shutdown — saves state, destroys Discord client, exits cleanly.
 * SIGINT/SIGTERM are registered only here (not in BotManager) to avoid double-shutdown.
 * @param {string} signal
 */
async function gracefulShutdown(signal) {
  logger.info(`Received ${signal} — graceful shutdown…`);

  try {
    logger.info('Saving final state…');
    await saveStateToFile();
    saveRuntimeConfig();  // flush per-key request counts to runtime-config.json

    logger.info('Closing Discord connection…');
    client.destroy();

    logger.info('Graceful shutdown complete ✅');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', error);
    process.exit(1);
  }
}

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', error);
  const fatal = ['ENOMEM', 'ENOSPC', 'MODULE_NOT_FOUND'];
  const isFatal = fatal.some(p => error.message?.includes(p) || error.code?.includes?.(p));
  if (isFatal) gracefulShutdown('uncaughtException');
  // Otherwise log and continue — the event loop is not corrupted.
});

process.on('unhandledRejection', (reason) => {
  const message   = reason?.message || String(reason);
  const isDiscord = reason?.code && typeof reason.code === 'number';

  if (isDiscord) {
    logger.warn(`Unhandled Discord error [${reason.code}]: ${message}`);
  } else {
    logger.error(`Unhandled Rejection: ${message}`, reason);
  }
  // Never shut down here — would kill the bot on any stray rejected promise.
});

// ============================================================================
// LOGIN
// ============================================================================

client.login(token).catch(error => {
  logger.critical('Failed to login to Discord', error);
  process.exit(1);
});
