/**
 * @fileoverview Settings interaction router — blacklist guard + dispatch to
 *               user/server handlers. All entry-points (button, select, modal)
 *               live here so index.js has one clean import.
 * @module modules/settings/SettingsRouter
 */

import { EmbedBuilder, MessageFlags } from 'discord.js';
import { initializeBlacklistForGuild } from '../../utils.js';
import { state }                        from '../../managers/BotManager.js';
import { Logger }                       from '../../core/Logger.js';

import {
  showMainSettings,
  showUserSettings,
  showUserSettingsPage2,
  showUserSettingsPage3,
  clearUserMemory,
  downloadUserConversation,
  showUserPersonalityModal,
  removeUserPersonality,
  showUserEmbedColorModal
} from './UserSettingsHandler.js';

import {
  showServerSettings,
  showServerSettingsPage2,
  showServerSettingsPage3,
  showServerSettingsPage4,
  showServerSettingsPage5,
  showChannelManagementMenu,
  handleSetAllChannels,
  handleChannelManageSelect,
  toggleContinuousReplyChannel,
  clearServerMemory,
  downloadServerConversation,
  showServerPersonalityModal,
  removeServerPersonality,
  showServerEmbedColorModal,
  handleServerResponseFormatNormal,
  handleServerResponseFormatEmbedded,
  handleServerToggleActionButtons,
  handleServerToggleOverride,
  handleServerToggleContinuous,
  handleServerToggleSrvHistory
} from './ServerSettingsHandler.js';

import {
  handleUserResponseFormatNormal,
  handleUserResponseFormatEmbedded,
  handleUserToggleActionButtons,
  handleUserToggleContinuousReply,
  handleUserTogglePersonalization,
  handleUserToggleCrossContext,
  handleUserPersonalityModal,
  handleServerPersonalityModal,
  handleUserEmbedColorModal,
  handleServerEmbedColorModal as handleServerEmbedColorModalSubmit,
  downloadMessage,
  handleDeleteMessageInteraction
} from './ActionHandlers.js';

const logger = Logger.get('SettingsRouter');

// ============================================================================
// BLACKLIST GUARD
// ============================================================================

async function isBlacklisted(interaction) {
  const guildId = interaction.guild?.id;
  if (!guildId) return false;

  initializeBlacklistForGuild(guildId);

  if (state.blacklistedUsers[guildId]?.includes(interaction.user.id)) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('Blacklisted')
          .setDescription('You are blacklisted and cannot use this interaction.')
      ],
      flags: MessageFlags.Ephemeral
    }).catch(() => {});
    return true;
  }
  return false;
}

// ============================================================================
// BUTTON ROUTER
// ============================================================================

const BUTTON_HANDLERS = {
  // ── Navigation ─────────────────────────────────────────────────────────────
  'nav_main':             (i) => showMainSettings(i, true),
  'nav_user_p1':          (i) => showUserSettings(i, true),
  'nav_user_p2':          (i) => showUserSettingsPage2(i, true),
  'nav_user_p3':          (i) => showUserSettingsPage3(i, true),
  'nav_server_p1':        (i) => showServerSettings(i, true),
  'nav_server_p2':        (i) => showServerSettingsPage2(i, true),
  'nav_server_p3':        (i) => showServerSettingsPage3(i, true),
  'nav_server_p4':        (i) => showServerSettingsPage4(i, true),
  'nav_server_p5':        (i) => showServerSettingsPage5(i, true),

  // ── << and >> aliases (avoid duplicate customIds when adjacent to p1/last) ─
  // Server: nav_server_first (<<) always goes to p1, nav_server_last (>>) goes to p5
  'nav_server_first':     (i) => showServerSettings(i, true),
  'nav_server_last':      (i) => showServerSettingsPage5(i, true),
  // User: nav_user_first (<<) always goes to p1, nav_user_last (>>) goes to p3
  'nav_user_first':       (i) => showUserSettings(i, true),
  'nav_user_last':        (i) => showUserSettingsPage3(i, true),

  // ── Legacy navigation aliases (backward compat) ────────────────────────────
  'user_settings':        (i) => showUserSettings(i, true),
  'server_settings':      (i) => showServerSettings(i, true),
  'back_to_main':         (i) => showMainSettings(i, true),
  'settings_btn':         (i) => showMainSettings(i, true),

  // ── User toggle buttons ────────────────────────────────────────────────────
  'user_set_format_normal':       handleUserResponseFormatNormal,
  'user_set_format_embedded':     handleUserResponseFormatEmbedded,
  'user_toggle_action_buttons':   handleUserToggleActionButtons,
  'user_toggle_continuous_reply': handleUserToggleContinuousReply,
  'user_toggle_personalization':  handleUserTogglePersonalization,
  'user_toggle_cross_context':    handleUserToggleCrossContext,

  // ── Server toggle buttons ──────────────────────────────────────────────────
  'server_set_format_normal':     handleServerResponseFormatNormal,
  'server_set_format_embedded':   handleServerResponseFormatEmbedded,
  'server_toggle_action_buttons': handleServerToggleActionButtons,
  'server_toggle_override':       handleServerToggleOverride,
  'server_toggle_continuous':     handleServerToggleContinuous,
  'server_toggle_srv_history':    handleServerToggleSrvHistory,

  // ── User actions ───────────────────────────────────────────────────────────
  'clear_user_memory':            clearUserMemory,
  'download_user_conversation':   downloadUserConversation,
  'user_custom_personality':      showUserPersonalityModal,
  'user_remove_personality':      removeUserPersonality,
  'user_embed_color':             showUserEmbedColorModal,

  // ── Server actions ─────────────────────────────────────────────────────────
  'clear_server_memory':          clearServerMemory,
  'download_server_conversation': downloadServerConversation,
  'server_custom_personality':    showServerPersonalityModal,
  'server_remove_personality':    removeServerPersonality,
  'server_embed_color':           showServerEmbedColorModal,

  // ── Channel management ─────────────────────────────────────────────────────
  'toggle_continuous_reply':      toggleContinuousReplyChannel,
  'manage_allowed_channels':      (i) => showChannelManagementMenu(i, true),
  'set_all_channels':             handleSetAllChannels,

  // ── Message actions ────────────────────────────────────────────────────────
  'download_message':             downloadMessage,
};

export async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return;
  if (await isBlacklisted(interaction)) return;

  if (interaction.customId.startsWith('delete_message-')) {
    const data = interaction.customId.replace('delete_message-', '');
    return handleDeleteMessageInteraction(interaction, data);
  }

  for (const [prefix, handler] of Object.entries(BUTTON_HANDLERS)) {
    if (interaction.customId.startsWith(prefix)) {
      try {
        await handler(interaction);
      } catch (error) {
        logger.error(`Button handler error [${prefix}]`, error);
      }
      return;
    }
  }
}

// ============================================================================
// SELECT MENU ROUTER
// ============================================================================

const SELECT_HANDLERS = {
  'channel_manage_select': handleChannelManageSelect,
};

export async function handleSelectMenuInteraction(interaction) {
  if (!interaction.isStringSelectMenu() && !interaction.isChannelSelectMenu()) return;
  if (await isBlacklisted(interaction)) return;

  const handler = SELECT_HANDLERS[interaction.customId];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (error) {
    logger.error(`Select handler error [${interaction.customId}]`, error);
  }
}

// ============================================================================
// MODAL ROUTER
// ============================================================================

const MODAL_HANDLERS = {
  'user_personality_modal':   handleUserPersonalityModal,
  'server_personality_modal': handleServerPersonalityModal,
  'user_embed_color_modal':   handleUserEmbedColorModal,
  'server_embed_color_modal': handleServerEmbedColorModalSubmit,
};

export async function handleModalSubmit(interaction) {
  if (!interaction.isModalSubmit()) return;

  const handler = MODAL_HANDLERS[interaction.customId];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (error) {
    logger.error(`Modal handler error [${interaction.customId}]`, error);
  }
}

export { showMainSettings };
