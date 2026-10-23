/**
 * @fileoverview Server settings pages (1–5) — Components V2 layout.
 *               Red accent sidebar, buttons inside the container,
 *               nav buttons at the bottom of the same container.
 *               No duplicate custom IDs.
 * @module modules/settings/ServerSettingsHandler
 */

import {
  MessageFlags, ButtonBuilder, ButtonStyle,
  ActionRowBuilder, ChannelSelectMenuBuilder, ChannelType,
  AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionsBitField, EmbedBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder
} from 'discord.js';
import path from 'path';
import fs   from 'fs/promises';

import {
  state, TEMP_DIR, BOT_CONFIG,
  DEFAULT_SERVER_SETTINGS, getDefaultServerSettings
} from '../../managers/BotManager.js';
import * as db    from '../../database.js';
import { Logger } from '../../core/Logger.js';

const logger = Logger.get('ServerSettings');

// Red accent sidebar — visible and on-brand
const ACCENT_COLOR  = 0xE53935;
// Fallback embed color for non-V2 messages (errors/confirmations)
const EMBED_COLOR   = '#E53935';

const TOTAL_SERVER_PAGES = 5;

// Components V2 flag (IsComponentsV2 = 1 << 15)
const IS_COMPONENTS_V2 = 1 << 15;

// ============================================================================
// HELPERS
// ============================================================================

function requireManageGuild(interaction) {
  if (!interaction.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Permission Denied')
        .setDescription('You require the **Manage Server** permission to view or modify server settings.')
      ],
      flags: MessageFlags.Ephemeral
    }).catch(() => {});
    return false;
  }
  return true;
}

export async function persistServer(guildId) {
  try {
    await db.saveServerSettings(guildId, state.serverSettings[guildId]);
  } catch (err) {
    logger.error(`Failed to persist server settings for ${guildId}`, err);
  }
}

export async function persistInstructions(id, instructions) {
  try {
    await db.saveCustomInstructions(id, instructions ?? null);
  } catch (err) {
    logger.error(`Failed to persist custom instructions for ${id}`, err);
  }
}

async function persistChannelSetting(channelId, type, value) {
  try {
    await db.saveChannelSetting(channelId, type, value);
  } catch (err) {
    logger.error(`Failed to persist channel setting for ${channelId}`, err);
  }
}

async function persistChatHistory(id) {
  try {
    await db.saveChatHistory(id, state.chatHistories[id] ?? {});
  } catch (err) {
    logger.error(`Failed to persist chat history for ${id}`, err);
  }
}

// ============================================================================
// SHARED UI BUILDERS
// ============================================================================

/**
 * Navigation ActionRow for server settings.
 * '<<' always uses 'nav_server_first' to avoid duplicate custom IDs when
 * page === 2 (where '<' would also resolve to nav_server_p1).
 */
function buildServerNavRow(page) {
  const isFirst = page === 1;
  const isLast  = page === TOTAL_SERVER_PAGES;

  // '<' back target: page 1 goes to main menu, otherwise previous page
  const prevId = isFirst ? 'nav_main' : `nav_server_p${page - 1}`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('nav_server_first')   // Unique ID — never clashes with prevId
      .setLabel('<<')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFirst),
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel('<')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`nav_server_p${page + 1}`)
      .setLabel('>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLast),
    new ButtonBuilder()
      .setCustomId('nav_server_last')    // Unique ID — never clashes with next page IDs
      .setLabel('>>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLast)
  );
}

/** Toggle button — green On / red Off reflecting current state. */
function toggleBtn(customId, isEnabled) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(isEnabled ? 'Enabled' : 'Disabled')
    .setStyle(isEnabled ? ButtonStyle.Success : ButtonStyle.Danger);
}

/** Format selector — two buttons, active one highlighted Primary. */
function formatBtns(current) {
  return [
    new ButtonBuilder()
      .setCustomId('server_set_format_normal')
      .setLabel('Normal')
      .setStyle(current === 'Normal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('server_set_format_embedded')
      .setLabel('Embedded')
      .setStyle(current === 'Embedded' ? ButtonStyle.Primary : ButtonStyle.Secondary),
  ];
}

/**
 * Builds a Components V2 container with a red accent bar.
 * Each setting block is: TextDisplay (name + description) → ActionRow (buttons).
 * Navigation sits at the very bottom inside the same container.
 */
function buildContainer(sections, navRow) {
  const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);

  for (let i = 0; i < sections.length; i++) {
    const { text, row } = sections[i];

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
    container.addActionRowComponents(row);

    // Separator between settings blocks, not after the last one
    if (i < sections.length - 1) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    }
  }

  // Separator before navigation
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addActionRowComponents(navRow);

  return container;
}

// ============================================================================
// PAGE 1 — Core Preferences
// ============================================================================

export async function showServerSettings(interaction, isUpdate = false) {
  if (!requireManageGuild(interaction)) return;

  const guildId        = interaction.guild.id;
  const ss             = state.serverSettings[guildId] || {};
  const responseFormat = ss.responseFormat    || getDefaultServerSettings().responseFormat || 'Normal';
  const showButtons    = ss.showActionButtons  ?? getDefaultServerSettings().showActionButtons ?? true;

  const container = buildContainer(
    [
      {
        text: `**Server Settings** — Page 1 of ${TOTAL_SERVER_PAGES}\n\n` +
              '**Response Format**\n' +
              'Controls how Lumin sends replies server-wide. Normal is plain text; Embedded uses rich cards.',
        row: new ActionRowBuilder().addComponents(...formatBtns(responseFormat))
      },
      {
        text: '**Action Buttons**\n' +
              'Toggles quick-action controls (Copy, Save, Delete) after each response across the server.',
        row: new ActionRowBuilder().addComponents(toggleBtn('server_toggle_action_buttons', showButtons))
      }
    ],
    buildServerNavRow(1)
  );

  const payload = {
    components: [container],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);
}

// ============================================================================
// PAGE 2 — Logic & Overrides
// ============================================================================

export async function showServerSettingsPage2(interaction, isUpdate = false) {
  if (!requireManageGuild(interaction)) return;

  const guildId              = interaction.guild.id;
  const ss                   = state.serverSettings[guildId] || {};
  const overrideUserSettings = ss.overrideUserSettings ?? false;
  const continuousReply      = ss.continuousReply       ?? false;
  const serverChatHistory    = ss.serverChatHistory     ?? false;

  const container = buildContainer(
    [
      {
        text: `**Server Settings** — Page 2 of ${TOTAL_SERVER_PAGES}\n\n` +
              '**Override User Settings**\n' +
              'When enabled, server-level settings take priority over individual user preferences.',
        row: new ActionRowBuilder().addComponents(toggleBtn('server_toggle_override', overrideUserSettings))
      },
      {
        text: '**Continuous Reply**\n' +
              'When enabled, Lumin responds to consecutive messages without requiring a mention each time.',
        row: new ActionRowBuilder().addComponents(toggleBtn('server_toggle_continuous', continuousReply))
      },
      {
        text: '**Server-Wide History**\n' +
              'When enabled, conversation history is shared across all users on this server.',
        row: new ActionRowBuilder().addComponents(toggleBtn('server_toggle_srv_history', serverChatHistory))
      }
    ],
    buildServerNavRow(2)
  );

  const payload = {
    components: [container],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);
}

// ============================================================================
// PAGE 3 — Appearance & Personality
// ============================================================================

export async function showServerSettingsPage3(interaction, isUpdate = false) {
  if (!requireManageGuild(interaction)) return;

  const guildId        = interaction.guild.id;
  const ss             = state.serverSettings[guildId] || {};
  const hasPersonality = !!ss.customPersonality;
  const embedColor     = ss.embedColor || BOT_CONFIG.HEX_COLOUR || EMBED_COLOR;

  const container = buildContainer(
    [
      {
        text: `**Server Settings** — Page 3 of ${TOTAL_SERVER_PAGES}\n\n` +
              '**Embed Color**\n' +
              `Set a server-wide accent color for Lumin's embeds. Current: \`${embedColor}\``,
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('server_embed_color')
            .setLabel('Set Color')
            .setStyle(ButtonStyle.Secondary)
        )
      },
      {
        text: '**Custom Personality**\n' +
              `Define a custom server-wide persona for Lumin. Status: \`${hasPersonality ? 'Active' : 'Default'}\``,
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('server_custom_personality')
            .setLabel('Set Personality')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('server_remove_personality')
            .setLabel('Reset Personality')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!hasPersonality)
        )
      }
    ],
    buildServerNavRow(3)
  );

  const payload = {
    components: [container],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);
}

// ============================================================================
// PAGE 4 — Channel Management
// ============================================================================

export async function showServerSettingsPage4(interaction, isUpdate = false) {
  if (!requireManageGuild(interaction)) return;

  const guildId         = interaction.guild.id;
  const ss              = state.serverSettings[guildId] || {};
  const allowedChannels = ss.allowedChannels || [];

  const channelList = allowedChannels.length > 0
    ? allowedChannels.slice(0, 5).map(id => `<#${id}>`).join(', ') +
      (allowedChannels.length > 5 ? ` +${allowedChannels.length - 5} more` : '')
    : 'All channels permitted';

  const container = buildContainer(
    [
      {
        text: `**Server Settings** — Page 4 of ${TOTAL_SERVER_PAGES}\n\n` +
              '**Allowed Channels**\n' +
              `Restrict Lumin to specific channels. Current scope: ${channelList}`,
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('manage_allowed_channels')
            .setLabel('Manage Channels')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('set_all_channels')
            .setLabel('Allow All Channels')
            .setStyle(ButtonStyle.Secondary)
        )
      },
      {
        text: '**Channel-Specific Mode**\n' +
              'Toggle continuous reply mode for the current channel without affecting server-wide settings.',
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('toggle_continuous_reply')
            .setLabel('Toggle Channel Mode')
            .setStyle(ButtonStyle.Secondary)
        )
      }
    ],
    buildServerNavRow(4)
  );

  const payload = {
    components: [container],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);
}

// ============================================================================
// PAGE 5 — Data Management
// ============================================================================

export async function showServerSettingsPage5(interaction, isUpdate = false) {
  if (!requireManageGuild(interaction)) return;

  const guildId  = interaction.guild.id;
  const hasMemory = Object.keys(state.chatHistories[guildId] || {}).length > 0;

  const container = buildContainer(
    [
      {
        text: `**Server Settings** — Page 5 of ${TOTAL_SERVER_PAGES}\n\n` +
              '**Clear Server Memory**\n' +
              '⚠️ Permanently erases all conversation history and server facts for this server.',
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('clear_server_memory')
            .setLabel('Clear Memory')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!hasMemory)
        )
      },
      {
        text: '**Export Server History**\n' +
              'Download the complete server conversation archive as a text file.',
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('download_server_conversation')
            .setLabel('Export History')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!hasMemory)
        )
      }
    ],
    buildServerNavRow(5)
  );

  const payload = {
    components: [container],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);
}

// ============================================================================
// CHANNEL MANAGEMENT MENU
// ============================================================================

export async function showChannelManagementMenu(interaction, isUpdate = false) {
  if (!requireManageGuild(interaction)) return;

  const guildId         = interaction.guild.id;
  const ss              = state.serverSettings[guildId] || {};
  const allowedChannels = ss.allowedChannels || [];

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('channel_manage_select')
    .setPlaceholder('Select authorized channels')
    .setMinValues(0).setMaxValues(25)
    .setChannelTypes([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum]);

  if (allowedChannels.length > 0) {
    const valid = allowedChannels.filter(id => interaction.guild.channels.cache.has(id)).slice(0, 25);
    if (valid.length > 0) channelSelect.setDefaultChannels(valid);
  }

  const currentValue = allowedChannels.length > 0
    ? allowedChannels.map(id => `<#${id}>`).join(', ')
    : 'All Channels';

  // ChannelSelectMenuBuilder cannot be placed inside a ContainerBuilder, so it lives
  // as a top-level ActionRow alongside the container.  The message still uses the
  // IS_COMPONENTS_V2 flag so that interaction.update() works when transitioning from
  // Page 4 (which is also a V2 message) — mixing V2 and non-V2 payloads in an
  // update() call is rejected by Discord.
  const container = new ContainerBuilder()
    .setAccentColor(ACCENT_COLOR)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '**Channel Management**\n\n' +
        'Select which channels Lumin is permitted to respond in. ' +
        'Leave empty to allow all channels.\n\n' +
        `**Current Scope:** ${currentValue}`
      )
    )
    .addSeparatorComponents(new SeparatorBuilder().setDivider(true))
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# Deselect all to authorize every channel.')
    );

  const payload = {
    components: [
      container,
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('nav_server_p4')
          .setLabel('< Back')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('set_all_channels')
          .setLabel('Allow All')
          .setStyle(ButtonStyle.Success)
      )
    ],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);
}

// ============================================================================
// TOGGLE HANDLERS — called from SettingsRouter
// ============================================================================

export async function handleServerResponseFormatNormal(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
  state.serverSettings[guildId].responseFormat = 'Normal';
  await persistServer(guildId);
  await showServerSettings(interaction, true);
}

export async function handleServerResponseFormatEmbedded(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
  state.serverSettings[guildId].responseFormat = 'Embedded';
  await persistServer(guildId);
  await showServerSettings(interaction, true);
}

export async function handleServerToggleActionButtons(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
  state.serverSettings[guildId].showActionButtons = !(state.serverSettings[guildId].showActionButtons ?? true);
  await persistServer(guildId);
  await showServerSettings(interaction, true);
}

export async function handleServerToggleOverride(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
  state.serverSettings[guildId].overrideUserSettings = !(state.serverSettings[guildId].overrideUserSettings ?? false);
  await persistServer(guildId);
  await showServerSettingsPage2(interaction, true);
}

export async function handleServerToggleContinuous(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
  state.serverSettings[guildId].continuousReply = !(state.serverSettings[guildId].continuousReply ?? false);
  await persistServer(guildId);
  await showServerSettingsPage2(interaction, true);
}

export async function handleServerToggleSrvHistory(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
  state.serverSettings[guildId].serverChatHistory = !(state.serverSettings[guildId].serverChatHistory ?? false);
  await persistServer(guildId);
  await showServerSettingsPage2(interaction, true);
}

export async function handleChannelManageSelect(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
  state.serverSettings[guildId].allowedChannels = interaction.values;
  await persistServer(guildId);
  await showChannelManagementMenu(interaction, true);
}

export async function handleSetAllChannels(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
  state.serverSettings[guildId].allowedChannels = [];
  await persistServer(guildId);
  await showChannelManagementMenu(interaction, true);
}

export async function toggleContinuousReplyChannel(interaction) {
  if (!requireManageGuild(interaction)) return;

  const channelId = interaction.channelId;
  if (!state.continuousReplyChannels) state.continuousReplyChannels = {};

  const newValue = !state.continuousReplyChannels[channelId];
  if (newValue) state.continuousReplyChannels[channelId] = true;
  else          delete state.continuousReplyChannels[channelId];

  await persistChannelSetting(channelId, 'continuousReply', newValue || null);

  const embed = newValue
    ? new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Channel Mode Enabled')
        .setDescription(`Continuous reply is now active in <#${channelId}>. Mentions are no longer required.`)
    : new EmbedBuilder().setColor(EMBED_COLOR).setTitle('Channel Mode Disabled')
        .setDescription(`Continuous reply is now inactive in <#${channelId}>. Explicit mentions are required.`);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ============================================================================
// DATA ACTIONS
// ============================================================================

export async function clearServerMemory(interaction) {
  if (!requireManageGuild(interaction)) return;
  const guildId = interaction.guild.id;
  state.chatHistories[guildId] = {};
  await persistChatHistory(guildId);
  await db.deleteAllServerFacts(guildId);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Memory Cleared')
      .setDescription('All server-wide conversation history and server facts have been permanently erased.')
    ],
    flags: MessageFlags.Ephemeral
  });
}

export async function downloadServerConversation(interaction) {
  if (!requireManageGuild(interaction)) return;

  const guildId = interaction.guild.id;
  const ss      = state.serverSettings[guildId] || {};

  if (!ss.serverChatHistory) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Feature Disabled')
        .setDescription('Server-wide chat history is currently disabled. Enable it on page 2 first.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  const historyObject = state.chatHistories[guildId];
  if (!historyObject || !Object.keys(historyObject).length) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('No History Found')
        .setDescription('There is no conversation history on record for this server.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  let conversationText = '';
  let messageCount     = 0;

  for (const messagesId of Object.keys(historyObject)) {
    for (const entry of historyObject[messagesId]) {
      const role         = entry.role === 'user' ? '[User]' : '[Assistant]';
      const contentParts = (entry.content || entry.parts || [])
        .filter(p => p.text || p.fileUri || p.fileData)
        .map(p => p.text || '[Media File Attached]');

      if (contentParts.length) {
        conversationText += `${role}:\n${contentParts.join('\n')}\n\n`;
        messageCount++;
      }
    }
  }

  if (!conversationText || messageCount === 0) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('No Readable History')
        .setDescription('The existing logs do not contain any exportable text content.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  const tempFile  = path.join(TEMP_DIR, `server_conversation_${interaction.id}.txt`);
  const header    = `Server Conversation History\nServer: ${interaction.guild.name}\nMessages: ${messageCount}\nExported: ${new Date().toLocaleString()}\n${'='.repeat(50)}\n\n`;
  await fs.writeFile(tempFile, header + conversationText, 'utf8');

  const { size } = await fs.stat(tempFile);
  const sizeMB   = size / (1024 * 1024);
  const safeName = interaction.guild.name.replace(/[^a-z0-9]/gi, '_');
  let fileSent   = false;
  let fallback;

  if (sizeMB <= 9.5) {
    try {
      await interaction.user.send({
        content: `**Server Conversation History**\nServer: ${interaction.guild.name} — Messages: ${messageCount}`,
        files: [new AttachmentBuilder(tempFile, { name: `${safeName}_history.txt` })]
      });
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('History Sent')
          .setDescription(`The server conversation history (${messageCount} messages) has been delivered to your DMs.`)
        ],
        flags: MessageFlags.Ephemeral
      });
      fileSent = true;
    } catch (err) {
      logger.error('DM send failed for server history', err);
      fallback = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('DM Failed')
        .setDescription('Could not deliver history to DMs. Uploading to a secure link.');
    }
  } else {
    fallback = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('History Too Large')
      .setDescription(`The history file is too large (${sizeMB.toFixed(2)} MB). Uploading to a secure link.`);
  }

  if (!fileSent) {
    const { uploadText } = await import('../../utils.js');
    const urlText = await uploadText(conversationText);
    const url     = urlText.match(/URL: (.+)/)?.[1] || urlText;
    const embed   = (fallback || new EmbedBuilder().setColor(EMBED_COLOR).setTitle('History Exported'))
      .addFields({ name: 'Archive Link', value: `[View Saved Logs](${url})`, inline: false });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  await fs.unlink(tempFile).catch(() => {});
}

// ============================================================================
// PERSONALITY / COLOR MODALS
// ============================================================================

export async function showServerPersonalityModal(interaction) {
  if (!requireManageGuild(interaction)) return;

  const guildId  = interaction.guild.id;
  const existing = (state.serverSettings[guildId] || {}).customPersonality || '';

  const input = new TextInputBuilder()
    .setCustomId('personality_input')
    .setLabel("Define Lumin's server personality")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter server custom personality instructions...')
    .setMinLength(10).setMaxLength(4000);
  if (existing) input.setValue(existing);

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId('server_personality_modal')
      .setTitle('Server Custom Personality')
      .addComponents(new ActionRowBuilder().addComponents(input))
  );
}

export async function removeServerPersonality(interaction) {
  if (!requireManageGuild(interaction)) return;

  const guildId = interaction.guild.id;
  if (state.serverSettings[guildId]) delete state.serverSettings[guildId].customPersonality;
  if (state.customInstructions?.[guildId]) delete state.customInstructions[guildId];
  await Promise.all([persistServer(guildId), persistInstructions(guildId, null)]);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Personality Reset')
      .setDescription('The server custom personality has been removed.')
    ],
    flags: MessageFlags.Ephemeral
  });
}

export async function showServerEmbedColorModal(interaction) {
  if (!requireManageGuild(interaction)) return;

  const guildId  = interaction.guild.id;
  const existing = (state.serverSettings[guildId] || {}).embedColor || BOT_CONFIG.HEX_COLOUR;

  const input = new TextInputBuilder()
    .setCustomId('color_input')
    .setLabel('Hex Color Code')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('#FF5733 or FF5733')
    .setMinLength(6).setMaxLength(7);
  if (existing) input.setValue(existing);

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId('server_embed_color_modal')
      .setTitle('Server Theme Color')
      .addComponents(new ActionRowBuilder().addComponents(input))
  );
}
