/**
 * @fileoverview User settings pages (1–3) — Components V2 layout.
 *               Red accent sidebar, buttons inside the container,
 *               nav buttons at the bottom of the same container.
 *               No duplicate custom IDs.
 * @module modules/settings/UserSettingsHandler
 */

import {
  MessageFlags, ButtonBuilder, ButtonStyle,
  ActionRowBuilder, AttachmentBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder
} from 'discord.js';
import path from 'path';
import fs   from 'fs/promises';

import {
  state, getHistory, TEMP_DIR, BOT_CONFIG,
  DEFAULT_USER_SETTINGS, getDefaultUserSettings
} from '../../managers/BotManager.js';
import * as db     from '../../database.js';
import { Logger }  from '../../core/Logger.js';

const logger = Logger.get('UserSettings');

// Red accent sidebar
const ACCENT_COLOR = 0xE53935;
// Fallback embed color for non-V2 messages (errors/confirmations)
const EMBED_COLOR  = '#E53935';

const TOTAL_USER_PAGES = 3;

// Components V2 flag (IsComponentsV2 = 1 << 15)
const IS_COMPONENTS_V2 = 1 << 15;

// ============================================================================
// PERSIST HELPERS
// ============================================================================

export async function persistUser(userId) {
  try {
    await db.saveUserSettings(userId, state.userSettings[userId]);
  } catch (err) {
    logger.error(`Failed to persist user settings for ${userId}`, err);
  }
}

export async function persistInstructions(id, instructions) {
  try {
    await db.saveCustomInstructions(id, instructions ?? null);
  } catch (err) {
    logger.error(`Failed to persist custom instructions for ${id}`, err);
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
// AUTO-DELETE
// ============================================================================

function scheduleAutoDelete(interaction, isUpdate) {
  if (isUpdate) return;
  setTimeout(async () => {
    try {
      const reply = await interaction.fetchReply().catch(() => null);
      if (reply) await interaction.deleteReply();
    } catch (err) {
      if (err.code !== 10008) logger.error('Error auto-deleting settings message', err);
    }
  }, 300_000);
}

// ============================================================================
// SHARED UI BUILDERS
// ============================================================================

/**
 * Navigation ActionRow for user settings.
 * '<<' always uses 'nav_user_first' to avoid duplicate custom IDs when
 * page === 2 (where '<' would also resolve to nav_user_p1).
 */
function buildUserNavRow(page) {
  const isFirst = page === 1;
  const isLast  = page === TOTAL_USER_PAGES;

  // '<' back target: page 1 goes to main menu, otherwise previous page
  const prevId = isFirst ? 'nav_main' : `nav_user_p${page - 1}`;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('nav_user_first')     // Unique ID — never clashes with prevId
      .setLabel('<<')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isFirst),
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel('<')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`nav_user_p${page + 1}`)
      .setLabel('>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLast),
    new ButtonBuilder()
      .setCustomId('nav_user_last')      // Unique ID — never clashes with next page IDs
      .setLabel('>>')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLast)
  );
}

/** Toggle button — green On / red Off. */
function toggleBtn(customId, isEnabled) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(isEnabled ? 'Enabled' : 'Disabled')
    .setStyle(isEnabled ? ButtonStyle.Success : ButtonStyle.Danger);
}

/** Format selector buttons. */
function formatBtns(current) {
  return [
    new ButtonBuilder()
      .setCustomId('user_set_format_normal')
      .setLabel('Normal')
      .setStyle(current === 'Normal' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('user_set_format_embedded')
      .setLabel('Embedded')
      .setStyle(current === 'Embedded' ? ButtonStyle.Primary : ButtonStyle.Secondary),
  ];
}

/**
 * Builds a Components V2 container with a red accent bar.
 * Each section: TextDisplay (name + description) → ActionRow (buttons).
 * Navigation sits at the very bottom inside the same container.
 */
function buildContainer(sections, navRow) {
  const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);

  for (let i = 0; i < sections.length; i++) {
    const { text, row } = sections[i];

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
    container.addActionRowComponents(row);

    if (i < sections.length - 1) {
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    }
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addActionRowComponents(navRow);

  return container;
}

// ============================================================================
// MAIN SETTINGS DASHBOARD
// ============================================================================

export async function showMainSettings(interaction, isUpdate = false) {
  try {
    const guildId   = interaction.guild?.id;
    const canManage = guildId
      ? interaction.member.permissions.has(0x20n)
      : false;

    let descText = '**Settings**\nSelect a configuration tier below to customize Lumin.\n\n' +
                   '**User Settings**\nPersonal defaults, response style, behavior, and privacy.';
    if (canManage) {
      descText += '\n\n**Server Settings**\nServer-wide overrides, channel controls, and data management.';
    }

    const btnRow = canManage
      ? new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('nav_user_p1').setLabel('User Settings').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId('nav_server_p1').setLabel('Server Settings').setStyle(ButtonStyle.Secondary)
        )
      : new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('nav_user_p1').setLabel('User Settings').setStyle(ButtonStyle.Primary)
        );

    const container = new ContainerBuilder()
      .setAccentColor(ACCENT_COLOR);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(descText));
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(btnRow);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Changes are saved automatically.'));

    const payload = {
      components: [container],
      flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
    };

    if (isUpdate) await interaction.update(payload);
    else           await interaction.reply(payload);

    scheduleAutoDelete(interaction, isUpdate);
  } catch (error) {
    logger.error('Error showing main settings', error);
  }
}

// ============================================================================
// PAGE 1 — Core Preferences
// ============================================================================

export async function showUserSettings(interaction, isUpdate = false) {
  const userId       = interaction.user.id;
  const userSettings = state.userSettings[userId] || {};
  const guildId      = interaction.guild?.id;

  if (guildId && !isUpdate) {
    const ss = state.serverSettings[guildId] || {};
    if (ss.overrideUserSettings) {
      interaction.user.send({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Server Override Active')
          .setDescription(`Settings on **${interaction.guild.name}** are locked by server administrators. Your personal preferences apply in DMs and other servers.`)
        ]
      }).catch(() => {});
    }
  }

  const responseFormat    = userSettings.responseFormat   || getDefaultUserSettings().responseFormat || 'Normal';
  const showActionButtons = userSettings.showActionButtons ?? getDefaultUserSettings().showActionButtons ?? true;

  const container = buildContainer(
    [
      {
        text: `**User Settings** — Page 1 of ${TOTAL_USER_PAGES}\n\n` +
              '**Response Format**\n' +
              'Controls how Lumin sends replies. Normal is plain text; Embedded uses rich cards.',
        row: new ActionRowBuilder().addComponents(...formatBtns(responseFormat))
      },
      {
        text: '**Action Buttons**\n' +
              'Toggles quick-action controls (Copy, Save, Delete) after each response.',
        row: new ActionRowBuilder().addComponents(toggleBtn('user_toggle_action_buttons', showActionButtons))
      }
    ],
    buildUserNavRow(1)
  );

  const payload = {
    components: [container],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);

  scheduleAutoDelete(interaction, isUpdate);
}

// ============================================================================
// PAGE 2 — Behavior
// ============================================================================

export async function showUserSettingsPage2(interaction, isUpdate = false) {
  const userId              = interaction.user.id;
  const userSettings        = state.userSettings[userId] || {};
  const continuousReply     = userSettings.continuousReply     ?? true;
  const crossContextEnabled = userSettings.crossContextEnabled ?? false;

  const container = buildContainer(
    [
      {
        text: `**User Settings** — Page 2 of ${TOTAL_USER_PAGES}\n\n` +
              '**Continuous Reply**\n' +
              'When enabled, Lumin responds to your consecutive messages without requiring a mention each time.',
        row: new ActionRowBuilder().addComponents(toggleBtn('user_toggle_continuous_reply', continuousReply))
      },
      {
        text: '**Cross-Context Memory**\n' +
              'When enabled, Lumin can draw on conversation history from across servers and DMs.',
        row: new ActionRowBuilder().addComponents(toggleBtn('user_toggle_cross_context', crossContextEnabled))
      }
    ],
    buildUserNavRow(2)
  );

  const payload = {
    components: [container],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);

  scheduleAutoDelete(interaction, isUpdate);
}

// ============================================================================
// PAGE 3 — Customization & Data
// ============================================================================

export async function showUserSettingsPage3(interaction, isUpdate = false) {
  const userId       = interaction.user.id;
  const userSettings = state.userSettings[userId] || {};
  const hasPersonality = !!userSettings.customPersonality;
  const hasMemory      = Object.keys(state.chatHistories[userId] || {}).length > 0;
  const embedColor     = userSettings.embedColor || BOT_CONFIG.HEX_COLOUR || EMBED_COLOR;

  const container = buildContainer(
    [
      {
        text: `**User Settings** — Page 3 of ${TOTAL_USER_PAGES}\n\n` +
              '**Embed Color**\n' +
              `Set a personal accent color for Lumin's embeds. Current: \`${embedColor}\``,
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('user_embed_color')
            .setLabel('Set Color')
            .setStyle(ButtonStyle.Secondary)
        )
      },
      {
        text: '**Custom Personality**\n' +
              `Define a personal persona for Lumin. Status: \`${hasPersonality ? 'Active' : 'Default'}\``,
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('user_custom_personality')
            .setLabel('Set Personality')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('user_remove_personality')
            .setLabel('Reset Personality')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!hasPersonality)
        )
      },
      {
        text: '**Data Management**\n' +
              'Clear your stored memory or export your chat history as a file.\n' +
              '⚠️ **Clear Memory** permanently removes your conversation history, personal facts, and session summaries.',
        row: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('clear_user_memory')
            .setLabel('Clear Memory')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!hasMemory),
          new ButtonBuilder()
            .setCustomId('download_user_conversation')
            .setLabel('Export History')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!hasMemory)
        )
      }
    ],
    buildUserNavRow(3)
  );

  const payload = {
    components: [container],
    flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
  };

  if (isUpdate) await interaction.update(payload);
  else           await interaction.reply(payload);

  scheduleAutoDelete(interaction, isUpdate);
}

// ============================================================================
// DATA ACTIONS
// ============================================================================

export async function clearUserMemory(interaction) {
  const userId = interaction.user.id;
  state.chatHistories[userId] = {};
  await persistChatHistory(userId);
  await Promise.all([
    db.deleteAllUserFacts(userId),
    db.deleteUserSessionSummaries(userId)
  ]);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Memory Cleared')
      .setDescription('Your conversation history, personal facts, and session summaries have all been permanently erased.')
    ],
    flags: MessageFlags.Ephemeral
  });
}

export async function downloadUserConversation(interaction) {
  const userId = interaction.user.id;
  const conversationHistory = getHistory(userId);

  if (!conversationHistory?.length) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('No History Found')
        .setDescription('There are no conversation logs recorded under your profile.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  const conversationText = conversationHistory.map(entry => {
    const role    = entry.role === 'user' ? '[User]' : '[Model]';
    const content = (entry.content || entry.parts || [])
      .map(c => c.text || '').filter(Boolean).join('\n');
    return `${role}:\n${content}\n\n`;
  }).join('');

  const tempFile = path.join(TEMP_DIR, `conversation_${interaction.id}.txt`);
  await fs.writeFile(tempFile, conversationText, 'utf8');

  const { size } = await fs.stat(tempFile);
  const sizeMB   = size / (1024 * 1024);
  let fileSent   = false;
  let fallback;

  if (sizeMB <= 9.5) {
    try {
      await interaction.user.send({
        content: '**Your Conversation History**',
        files: [new AttachmentBuilder(tempFile, { name: 'conversation_history.txt' })]
      });
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('History Sent')
          .setDescription('Your complete conversation history has been delivered to your DMs.')
        ],
        flags: MessageFlags.Ephemeral
      });
      fileSent = true;
    } catch (err) {
      logger.error('DM send failed for history download', err);
      fallback = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('DM Failed')
        .setDescription('Could not deliver history to DMs. Attempting direct upload.');
    }
  } else {
    fallback = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('History Too Large')
      .setDescription(`The conversation history is too large (${sizeMB.toFixed(2)} MB). Uploading to a secure link.`);
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

export async function showUserPersonalityModal(interaction) {
  const userId   = interaction.user.id;
  const existing = (state.userSettings[userId] || {}).customPersonality || '';

  const input = new TextInputBuilder()
    .setCustomId('personality_input')
    .setLabel("Define Lumin's user personality")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter your custom personality instructions...')
    .setMinLength(10).setMaxLength(4000);
  if (existing) input.setValue(existing);

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId('user_personality_modal')
      .setTitle('Custom Personality')
      .addComponents(new ActionRowBuilder().addComponents(input))
  );
}

export async function removeUserPersonality(interaction) {
  const userId = interaction.user.id;
  if (state.userSettings[userId]) delete state.userSettings[userId].customPersonality;
  if (state.customInstructions?.[userId]) delete state.customInstructions[userId];
  await Promise.all([persistUser(userId), persistInstructions(userId, null)]);
  await interaction.reply({
    embeds: [new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Personality Reset')
      .setDescription('Your custom personality instructions have been removed.')
    ],
    flags: MessageFlags.Ephemeral
  });
}

export async function showUserEmbedColorModal(interaction) {
  const userId   = interaction.user.id;
  const existing = (state.userSettings[userId] || {}).embedColor || BOT_CONFIG.HEX_COLOUR;

  const input = new TextInputBuilder()
    .setCustomId('color_input')
    .setLabel('Hex Color Code')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('#FF5733 or FF5733')
    .setMinLength(6).setMaxLength(7);
  if (existing) input.setValue(existing);

  await interaction.showModal(
    new ModalBuilder()
      .setCustomId('user_embed_color_modal')
      .setTitle('Theme Color')
      .addComponents(new ActionRowBuilder().addComponents(input))
  );
}
