/**
 * @fileoverview Action handlers: toggle buttons, modal submissions,
 *               download-message, and delete-message.
 * @module modules/settings/ActionHandlers
 */

import {
  EmbedBuilder, MessageFlags, AttachmentBuilder, ChannelType
} from 'discord.js';
import path from 'path';
import fs   from 'fs/promises';

import { state, TEMP_DIR, BOT_CONFIG } from '../../managers/BotManager.js';
import * as db    from '../../database.js';
import { Logger } from '../../core/Logger.js';
import { Embeds } from '../shared/embedBuilder.js';
import { PERSONALIZATION_DEFAULT } from '../config.js';

import {
  showUserSettings,
  showUserSettingsPage2,
  persistUser,
  persistInstructions
} from './UserSettingsHandler.js';

import {
  showServerSettings,
  showServerSettingsPage2,
  persistServer
} from './ServerSettingsHandler.js';

const logger     = Logger.get('ActionHandlers');
const EMBED_COLOR = '#111214';

// ============================================================================
// USER TOGGLE BUTTON HANDLERS
// ============================================================================

export async function handleUserResponseFormatNormal(interaction) {
  const userId = interaction.user.id;
  if (!state.userSettings[userId]) state.userSettings[userId] = {};
  state.userSettings[userId].responseFormat = 'Normal';
  await persistUser(userId);
  await showUserSettings(interaction, true);
}

export async function handleUserResponseFormatEmbedded(interaction) {
  const userId = interaction.user.id;
  if (!state.userSettings[userId]) state.userSettings[userId] = {};
  state.userSettings[userId].responseFormat = 'Embedded';
  await persistUser(userId);
  await showUserSettings(interaction, true);
}

export async function handleUserToggleActionButtons(interaction) {
  const userId = interaction.user.id;
  if (!state.userSettings[userId]) state.userSettings[userId] = {};
  state.userSettings[userId].showActionButtons = !(state.userSettings[userId].showActionButtons ?? true);
  await persistUser(userId);
  await showUserSettings(interaction, true);
}

export async function handleUserToggleContinuousReply(interaction) {
  const userId = interaction.user.id;
  if (!state.userSettings[userId]) state.userSettings[userId] = {};
  state.userSettings[userId].continuousReply = !(state.userSettings[userId].continuousReply ?? true);
  await persistUser(userId);
  await showUserSettingsPage2(interaction, true);
}

export async function handleUserTogglePersonalization(interaction) {
  const userId = interaction.user.id;
  if (!state.userSettings[userId]) state.userSettings[userId] = {};
  const current = state.userSettings[userId].personalization ?? state.userSettings[userId].crossContextEnabled ?? PERSONALIZATION_DEFAULT;
  const next = !current;
  state.userSettings[userId].personalization = next;
  state.userSettings[userId].crossContextEnabled = next;
  await persistUser(userId);
  await showUserSettingsPage2(interaction, true);
}

export const handleUserToggleCrossContext = handleUserTogglePersonalization;

// ============================================================================
// MODAL SUBMIT HANDLERS
// ============================================================================

const HEX_RE = /^#?([0-9A-Fa-f]{6})$/;

function parseHex(raw) {
  const m = raw.trim().match(HEX_RE);
  return m ? (raw.trim().startsWith('#') ? raw.trim() : `#${raw.trim()}`) : null;
}

export async function handleUserPersonalityModal(interaction) {
  const userId = interaction.user.id;
  try {
    const input = interaction.fields.getTextInputValue('personality_input');
    if (!state.userSettings[userId]) state.userSettings[userId] = {};
    state.userSettings[userId].customPersonality = input.trim();
    await persistUser(userId);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Personality Saved')
        .setDescription('Your custom personality instructions have been applied.')
      ],
      flags: MessageFlags.Ephemeral
    });
  } catch (err) {
    logger.error('Error saving user personality', err);
  }
}

export async function handleServerPersonalityModal(interaction) {
  const guildId = interaction.guild?.id;
  if (!interaction.member.permissions.has(0x20n)) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Permission Denied')
        .setDescription('You require the **Manage Server** permission.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  try {
    const input = interaction.fields.getTextInputValue('personality_input');
    if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
    state.serverSettings[guildId].customPersonality = input.trim();
    await persistServer(guildId);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Personality Saved')
        .setDescription('Server custom personality instructions have been applied.')
      ],
      flags: MessageFlags.Ephemeral
    });
  } catch (err) {
    logger.error('Error saving server personality', err);
  }
}

export async function handleUserEmbedColorModal(interaction) {
  const userId = interaction.user.id;
  try {
    const raw = interaction.fields.getTextInputValue('color_input');
    const hex = parseHex(raw);
    if (!hex) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Invalid Color')
          .setDescription('Provide a valid hex color code (e.g. `#FF5733` or `FF5733`).')
        ],
        flags: MessageFlags.Ephemeral
      });
    }
    if (!state.userSettings[userId]) state.userSettings[userId] = {};
    state.userSettings[userId].embedColor = hex;
    await persistUser(userId);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(hex)
        .setTitle('Color Updated')
        .setDescription(`Your embed color has been set to \`${hex}\`.`)
      ],
      flags: MessageFlags.Ephemeral
    });
  } catch (err) {
    logger.error('Error saving user embed color', err);
  }
}

export async function handleServerEmbedColorModal(interaction) {
  const guildId = interaction.guild?.id;
  if (!interaction.member.permissions.has(0x20n)) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Permission Denied')
        .setDescription('You require the **Manage Server** permission.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  try {
    const raw = interaction.fields.getTextInputValue('color_input');
    const hex = parseHex(raw);
    if (!hex) {
      return interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Invalid Color')
          .setDescription('Provide a valid hex color code (e.g. `#FF5733` or `FF5733`).')
        ],
        flags: MessageFlags.Ephemeral
      });
    }
    if (!state.serverSettings[guildId]) state.serverSettings[guildId] = {};
    state.serverSettings[guildId].embedColor = hex;
    await persistServer(guildId);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(hex)
        .setTitle('Color Updated')
        .setDescription(`Server embed color has been set to \`${hex}\`.`)
      ],
      flags: MessageFlags.Ephemeral
    });
  } catch (err) {
    logger.error('Error saving server embed color', err);
  }
}

// ============================================================================
// DOWNLOAD MESSAGE
// ============================================================================

export async function downloadMessage(interaction) {
  const message = interaction.message;
  const textContent = message.content || message.embeds?.[0]?.description;

  if (!textContent) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Empty Message')
        .setDescription('The message appears to contain no exportable text.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  const filePath = path.join(TEMP_DIR, `message_content_${interaction.id}.txt`);
  await fs.writeFile(filePath, textContent, 'utf8');

  const attachment = new AttachmentBuilder(filePath, { name: 'message_content.txt' });
  const baseEmbed  = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Message Saved')
    .setDescription('The message content has been prepared for download.');

  let response;

  if (interaction.channel.type === ChannelType.DM) {
    await interaction.reply({ embeds: [baseEmbed], files: [attachment] });
    response = await interaction.fetchReply();
  } else {
    try {
      await interaction.user.send({ embeds: [baseEmbed], files: [attachment] });
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('Sent to DMs')
          .setDescription('The message content has been delivered to your DMs.')
        ],
        flags: MessageFlags.Ephemeral
      });
      response = await interaction.fetchReply();
    } catch (err) {
      logger.error('Failed to send download DM', err);
      await interaction.reply({
        embeds: [new EmbedBuilder()
          .setColor(EMBED_COLOR)
          .setTitle('DM Failed')
          .setDescription('Could not send to DMs. Here is the file directly:')
        ],
        files: [attachment],
        flags: MessageFlags.Ephemeral
      });
      response = await interaction.fetchReply();
    }
  }

  await fs.unlink(filePath).catch(() => {});

  try {
    const { uploadText } = await import('../../utils.js');
    const msgUrl = await uploadText(textContent);
    const updated = EmbedBuilder.from(response.embeds[0])
      .setDescription(`The message content has been saved.\n${msgUrl}`);

    if (interaction.channel.type === ChannelType.DM) {
      await interaction.editReply({ embeds: [updated] });
    } else {
      await response.edit({ embeds: [updated] }).catch(() => {});
    }
  } catch (err) {
    logger.error('Failed to update download message with URL', err);
  }
}

// ============================================================================
// DELETE MESSAGE
// ============================================================================

export async function handleDeleteMessageInteraction(interaction, customIdData) {
  const lastDash = customIdData.lastIndexOf('-');

  if (lastDash === -1) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Authorization Error')
        .setDescription('Unable to verify authorization for this message.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  const ownerId   = customIdData.substring(lastDash + 1);
  const clickerId = interaction.user.id;

  if (clickerId !== ownerId) {
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('Not Authorized')
        .setDescription('Only the user who triggered this response can delete it.')
      ],
      flags: MessageFlags.Ephemeral
    });
  }

  await interaction.message.delete().catch(() => {});
}
