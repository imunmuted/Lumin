/**
 * @fileoverview /reminder command — create, view and delete user reminders.
 *               Pure interaction handler; scheduling lives in ReminderScheduler.js.
 * @module commands/reminder/ReminderHandler
 */

import {
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder
} from 'discord.js';

import { state, saveStateToFile }    from '../../managers/BotManager.js';
import { memorySystem }               from '../../memory/MemorySystem.js';
import * as db                        from '../../database/index.js';
import { Logger }                     from '../../core/Logger.js';
import { SYSTEM_AGENT_CALLSIGN }      from '../../modules/config.js';
import { scheduleReminder }           from './ReminderScheduler.js';
import { getUserTime }                 from '../timezone.js';

const logger = Logger.get('ReminderHandler');

const MAX_REMINDERS_PER_USER = 10;
/** Temp reminder data TTL: 5 minutes */
const TEMP_DATA_TTL_MS       = 5 * 60 * 1000;

// ============================================================================
// COMMAND DEFINITION
// ============================================================================

export const reminderCommand = {
  name:        'reminder',
  description: 'Set reminders for yourself (max 10 reminders)'
};

// ============================================================================
// ENTRY POINT
// ============================================================================

const ACCENT_COLOR     = 0xE53935;
const IS_COMPONENTS_V2 = 1 << 15;

/**
 * @param {import('discord.js').CommandInteraction} interaction
 */
export async function handleReminderCommand(interaction) {
  try {
    const userId      = interaction.user.id;
    const activeCount = (state.reminders?.[userId] ?? []).filter(r => r.active).length;

    const actionSelect = new StringSelectMenuBuilder()
      .setCustomId('reminder_action')
      .setPlaceholder('Select an action')
      .addOptions(
        { label: 'Add Reminder',    value: 'add',    description: 'Create a new reminder', emoji: '➕'  },
        { label: 'View Reminders',  value: 'view',   description: 'See all your reminders', emoji: '📋' },
        { label: 'Delete Reminder', value: 'delete', description: 'Remove a reminder',      emoji: '🗑️' }
      );

    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '**Reminders**\n' +
        `Create, view, or remove personal reminders. ${SYSTEM_AGENT_CALLSIGN} will notify you at your scheduled time.\n\n` +
        `**Active Reminders:** ${activeCount}/${MAX_REMINDERS_PER_USER}`
      )
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(actionSelect));

    await interaction.reply({
      components: [container],
      flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
    });
  } catch (error) {
    logger.error('handleReminderCommand failed', error);
    await sendError(interaction, 'An error occurred processing the reminder command.');
  }
}

// ============================================================================
// SELECT MENU HANDLERS
// ============================================================================

/**
 * Route Add / View / Delete selection.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleReminderActionSelect(interaction) {
  try {
    const action = interaction.values[0];
    if      (action === 'add')    await showReminderTypeSelect(interaction);
    else if (action === 'view')   await viewReminders(interaction);
    else if (action === 'delete') await showDeleteReminderMenu(interaction);
  } catch (error) {
    logger.error('handleReminderActionSelect failed', error);
    await sendError(interaction, 'Failed to process your selection.', true, true);
  }
}

/**
 * Reminder type selected (once / daily / weekly / monthly) → show input modal.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleReminderTypeSelect(interaction) {
  try {
    const type        = interaction.values[0];
    const typeLabel   = type.charAt(0).toUpperCase() + type.slice(1);

    const messageInput = new TextInputBuilder()
      .setCustomId('reminder_message')
      .setLabel('What should I remind you about?')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('e.g., Take medication, Study for exam')
      .setRequired(true)
      .setMaxLength(500);

    const timeInput = buildTimeInput(type);

    const modal = new ModalBuilder()
      .setCustomId(`reminder_modal_${type}`)
      .setTitle(`Set ${typeLabel} Reminder`)
      .addComponents(
        new ActionRowBuilder().addComponents(messageInput),
        new ActionRowBuilder().addComponents(timeInput)
      );

    await interaction.showModal(modal);
  } catch (error) {
    logger.error('handleReminderTypeSelect failed', error);
    await sendError(interaction, 'Failed to show reminder modal.', true, true);
  }
}

/**
 * Modal submitted → ask for delivery location.
 * Stores temp data on `client.tempReminderData` (TTL: 5 min).
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
export async function handleReminderModal(interaction) {
  try {
    const type    = interaction.customId.split('_')[2];
    const message = interaction.fields.getTextInputValue('reminder_message');
    const timeStr = interaction.fields.getTextInputValue('reminder_time');

    const userId      = interaction.user.id;
    const guildId     = interaction.guild?.id;
    const uniqueStepId = `${userId}_${Date.now()}`;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('⏰ Reminder Location')
      .setDescription(
        `**Reminder:** ${message}\n**Type:** ${type}\n**Time:** ${timeStr}\n\n` +
        `Where should I send this reminder?`
      );

    const locationSelect = new StringSelectMenuBuilder()
      .setCustomId(`reminder_location_${uniqueStepId}`)
      .setPlaceholder('Choose notification location');

    if (guildId) {
      locationSelect.addOptions(
        { label: 'DM Only',     value: 'dm',     description: 'Receive in direct messages',     emoji: '📬' },
        { label: 'Server Only', value: 'server', description: 'Get notified in this server',     emoji: '💬' },
        { label: 'Both',        value: 'both',   description: 'DM + Server notification',        emoji: '📢' }
      );
    } else {
      locationSelect.addOptions(
        { label: 'DM', value: 'dm', description: 'Receive in direct messages', emoji: '📬' }
      );
    }

    // Stash temp data — auto-expire after TTL
    if (!interaction.client.tempReminderData) {
      interaction.client.tempReminderData = new Map();
    }
    interaction.client.tempReminderData.set(uniqueStepId, { type, message, timeStr, guildId, userId });
    setTimeout(
      () => interaction.client.tempReminderData?.delete(uniqueStepId),
      TEMP_DATA_TTL_MS
    );

    await interaction.reply({
      embeds:     [embed],
      components: [new ActionRowBuilder().addComponents(locationSelect)],
      flags:      MessageFlags.Ephemeral
    });
  } catch (error) {
    logger.error('handleReminderModal failed', error);
    await sendError(interaction, 'Failed to process reminder details.');
  }
}

/**
 * Location selected → parse time, persist, schedule.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleReminderLocationSelect(interaction) {
  try {
    // Acknowledge immediately — DB/file-IO below can exceed the 3-second window.
    await interaction.deferUpdate();

    const uniqueStepId = interaction.customId.replace('reminder_location_', '');
    const userId       = interaction.user.id;
    const tempData     = interaction.client.tempReminderData?.get(uniqueStepId);

    if (!tempData) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Expired')
        .setDescription('This reminder setup has expired. Please start again with `/reminder`');
      return interaction.editReply({ embeds: [embed], components: [] });
    }

    // Ownership guard
    if (tempData.userId !== userId) {
      return interaction.editReply({
        content: 'This interaction does not belong to you.',
        components: []
      });
    }

    const { type, message, timeStr, guildId } = tempData;
    const location = interaction.values[0];

    // --- Parse time ---
    let parsedTime;
    try {
      parsedTime = parseReminderTime(type, timeStr);
    } catch (parseError) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Invalid Time Format')
        .setDescription(
          `Could not parse the time: "${timeStr}"\n\n${parseError.message}\n\n` +
          `Check for correct AM/PM format.`
        );
      return interaction.editReply({ embeds: [embed], components: [] });
    }

    // --- Past-time guard (once reminders only) ---
    if (type === 'once') {
      const userNow  = getUserTime(userId);
      const nowVal   =
        userNow.getFullYear()      * 100_000_000 +
        (userNow.getMonth() + 1)   *   1_000_000 +
        userNow.getDate()          *      10_000 +
        userNow.getHours()         *         100 +
        userNow.getMinutes();
      const targetVal =
        parsedTime.year  * 100_000_000 +
        parsedTime.month *   1_000_000 +
        parsedTime.day   *      10_000 +
        parsedTime.hour  *         100 +
        parsedTime.minute;

      if (targetVal < nowVal) {
        const embed = new EmbedBuilder()
          .setColor(0xFF5555)
          .setTitle('❌ Time is in the Past')
          .setDescription(
            `The date/time \`${timeStr}\` has already passed.\n\n` +
            `Please run \`/reminder\` again and enter a future date and time.`
          );
        return interaction.editReply({ embeds: [embed], components: [] });
      }
    }

    // --- Cap check ---
    if (!state.reminders)         state.reminders         = {};
    if (!state.reminders[userId]) state.reminders[userId] = [];

    const activeCount = state.reminders[userId].filter(r => r.active).length;
    if (activeCount >= MAX_REMINDERS_PER_USER) {
      const embed = new EmbedBuilder()
        .setColor(0xFF5555)
        .setTitle('❌ Reminder Limit Reached')
        .setDescription(`You have reached the maximum limit of ${MAX_REMINDERS_PER_USER} reminders.`);
      return interaction.editReply({ embeds: [embed], components: [] });
    }

    // --- Persist ---
    const reminder = {
      id:        `${userId}_${Date.now()}`,
      type,
      message,
      time:      parsedTime,
      location,
      guildId:   location !== 'dm' ? guildId : null,
      active:    true,
      createdAt: Date.now()
    };

    state.reminders[userId].push(reminder);
    await db.saveReminder(userId, reminder);
    await saveStateToFile();

    scheduleReminder(interaction.client, reminder);
    memorySystem.invalidatePersonalDataCache(userId);
    interaction.client.tempReminderData.delete(uniqueStepId);

    const locationText   = { dm: 'DMs', server: 'this server', both: 'DMs and this server' }[location];
    const timeDisplay    = formatReminderTime(type, parsedTime);
    const newActiveCount = state.reminders[userId].filter(r => r.active).length;

    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Reminder Set!')
      .setDescription(
        `**Message:** ${message}\n**Type:** ${type}\n**Trigger:** ${timeDisplay}\n**Location:** ${locationText}`
      )
      .setFooter({ text: `Active reminders: ${newActiveCount}/${MAX_REMINDERS_PER_USER}` });

    await interaction.editReply({ embeds: [embed], components: [] });

  } catch (error) {
    logger.error('handleReminderLocationSelect failed', error);
    await sendError(interaction, 'Failed to save reminder.');
  }
}

/**
 * Delete reminder chosen from dropdown.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleReminderDeleteSelect(interaction) {
  try {
    // Acknowledge immediately — DB/file-IO below can exceed the 3-second window.
    await interaction.deferUpdate();

    const reminderId = interaction.values[0];
    const userId     = interaction.user.id;

    const idx = state.reminders?.[userId]?.findIndex(r => r.id === reminderId) ?? -1;
    if (idx === -1) {
      const container = new ContainerBuilder().setAccentColor(0xFF5555);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('❌ **Reminder Not Found**\nCould not find that reminder.')
      );
      return interaction.editReply({ components: [container], flags: IS_COMPONENTS_V2 });
    }

    const reminder = state.reminders[userId][idx];
    state.reminders[userId].splice(idx, 1);

    // Cancel the live interval
    if (interaction.client.reminderIntervals?.has(reminderId)) {
      clearInterval(interaction.client.reminderIntervals.get(reminderId));
      interaction.client.reminderIntervals.delete(reminderId);
    }

    await db.deleteReminder(reminderId);
    await saveStateToFile();
    memorySystem.invalidatePersonalDataCache(userId);

    const activeCount = state.reminders[userId].filter(r => r.active).length;

    const container = new ContainerBuilder().setAccentColor(0x57F287);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `✅ **Reminder Deleted**\nDeleted: **${reminder.message}**\n\n` +
        `-# Active reminders: ${activeCount}/${MAX_REMINDERS_PER_USER}`
      )
    );

    await interaction.editReply({ components: [container], flags: IS_COMPONENTS_V2 });
  } catch (error) {
    logger.error('handleReminderDeleteSelect failed', error);
    await sendError(interaction, 'Failed to delete reminder.');
  }
}

// ============================================================================
// PRIVATE — UI HELPERS
// ============================================================================

/** Show reminder type picker (or limit-reached button). */
async function showReminderTypeSelect(interaction) {
  try {
    const userId      = interaction.user.id;
    const activeCount = (state.reminders?.[userId] ?? []).filter(r => r.active).length;

    if (activeCount >= MAX_REMINDERS_PER_USER) {
      const deleteButton = new ButtonBuilder()
        .setCustomId('reminder_action_delete')
        .setLabel('Delete Reminders')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🗑️');

      const container = new ContainerBuilder().setAccentColor(0xFF5555);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '❌ **Reminder Limit Reached**\n' +
          `You have reached the maximum limit of ${MAX_REMINDERS_PER_USER} reminders.\n\n` +
          `Please delete some old reminders before creating new ones.`
        )
      );
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addActionRowComponents(new ActionRowBuilder().addComponents(deleteButton));

      return interaction.update({
        components: [container],
        flags:      IS_COMPONENTS_V2
      });
    }

    const typeSelect = new StringSelectMenuBuilder()
      .setCustomId('reminder_type')
      .setPlaceholder('Select reminder frequency')
      .addOptions(
        { label: 'Once (specific time)', value: 'once',    description: 'One-time reminder',         emoji: '⏱️' },
        { label: 'Daily',                value: 'daily',   description: 'Repeats every day',          emoji: '📅' },
        { label: 'Weekly',               value: 'weekly',  description: 'Repeats every week',         emoji: '📆' },
        { label: 'Monthly',              value: 'monthly', description: 'Repeats every month',        emoji: '🗓️' }
      );

    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('⏰ **Reminder Setup**\nChoose how often you want to be reminded:')
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(typeSelect));

    await interaction.update({
      components: [container],
      flags:      IS_COMPONENTS_V2
    });
  } catch (error) {
    logger.error('showReminderTypeSelect failed', error);
    await sendError(interaction, 'Failed to show reminder types.', true, true);
  }
}

/** Show active reminders as a text list. */
async function viewReminders(interaction) {
  try {
    const userId   = interaction.user.id;
    const active   = (state.reminders?.[userId] ?? []).filter(r => r.active);

    if (active.length === 0) {
      const container = new ContainerBuilder().setAccentColor(0xFF5555);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "📋 **No Active Reminders**\n\nYou don't have any active reminders.\n\nUse `/reminder` to create one!"
        )
      );
      return interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
    }

    const list = active
      .map((r, i) => {
        const timeDisplay = formatReminderTime(r.type, r.time);
        const loc         = r.location === 'dm' ? 'DMs' : r.location === 'both' ? 'DMs & Server' : 'Server';
        return `**${i + 1}.** ${r.message}\n⏰ ${timeDisplay}\n📍 ${loc}`;
      })
      .join('\n\n');

    const container = new ContainerBuilder().setAccentColor(0x5865F2);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `📋 **Your Active Reminders**\n\n${list}\n\n` +
        `-# ${active.length}/${MAX_REMINDERS_PER_USER} reminders active`
      )
    );

    await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
  } catch (error) {
    logger.error('viewReminders failed', error);
    await sendError(interaction, 'Failed to view reminders.', true, true);
  }
}

/**
 * Entry point for the "Delete Reminders" button shown on the limit-reached screen.
 * Delegates directly to showDeleteReminderMenu.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleReminderDeleteButton(interaction) {
  await showDeleteReminderMenu(interaction);
}

/** Show delete picker dropdown. */
async function showDeleteReminderMenu(interaction) {
  try {
    const userId = interaction.user.id;
    const active = (state.reminders?.[userId] ?? []).filter(r => r.active);

    if (active.length === 0) {
      const container = new ContainerBuilder().setAccentColor(0xFF5555);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent("❌ **No Reminders**\n\nYou don't have any active reminders to delete.")
      );
      return interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
    }

    const deleteSelect = new StringSelectMenuBuilder()
      .setCustomId('reminder_delete_select')
      .setPlaceholder('Choose reminder to delete')
      .addOptions(
        active.slice(0, 25).map((r, i) => ({
          label:       `${i + 1}. ${r.message.slice(0, 50)}`,
          description: formatReminderTime(r.type, r.time).slice(0, 100),
          value:       r.id
        }))
      );

    const container = new ContainerBuilder().setAccentColor(0xFF6B6B);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('🗑️ **Delete Reminder**\nSelect a reminder to delete:')
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(deleteSelect));

    await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
  } catch (error) {
    logger.error('showDeleteReminderMenu failed', error);
    await sendError(interaction, 'Failed to show delete menu.', true, true);
  }
}

// ============================================================================
// PRIVATE — PURE UTILITIES
// ============================================================================

/**
 * Build the correct time TextInput based on reminder type.
 * @param {'once'|'daily'|'weekly'|'monthly'} type
 * @returns {TextInputBuilder}
 */
function buildTimeInput(type) {
  const base = new TextInputBuilder()
    .setCustomId('reminder_time')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  switch (type) {
    case 'once':
      return base
        .setLabel('When? (YYYY-MM-DD HH:MM AM/PM)')
        .setPlaceholder('e.g., 2024-12-25 02:30 PM');
    case 'daily':
      return base
        .setLabel('What time? (HH:MM AM/PM)')
        .setPlaceholder('e.g., 09:00 AM, 14:30, 8:00 PM');
    case 'weekly':
      return base
        .setLabel('Day and time? (Day HH:MM AM/PM)')
        .setPlaceholder('e.g., Monday 09:00 AM, Friday 5:00 PM');
    case 'monthly':
      return base
        .setLabel('Day and time? (Day HH:MM AM/PM)')
        .setPlaceholder('e.g., 1 09:00 AM, 15 2:00 PM');
  }
}

/**
 * Parse a user-entered time string into structured components.
 * Throws a descriptive Error with the correct format string on failure.
 *
 * @param {'once'|'daily'|'weekly'|'monthly'} type
 * @param {string} timeStr
 * @returns {object}  Time components object.
 */
function parseReminderTime(type, timeStr) {
  const to24Hour = (hourStr, ampm) => {
    const h = parseInt(hourStr);
    if (!ampm)                          return h;
    if (ampm.toUpperCase() === 'PM' && h < 12) return h + 12;
    if (ampm.toUpperCase() === 'AM' && h === 12) return 0;
    return h;
  };

  switch (type) {
    case 'once': {
      const m = timeStr.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
      if (!m) throw new Error('Format: YYYY-MM-DD HH:MM (AM/PM)  e.g., 2024-12-25 02:30 PM');
      const [, year, month, day, hourStr, minute, ampm] = m;
      return { year: +year, month: +month, day: +day, hour: to24Hour(hourStr, ampm), minute: +minute };
    }

    case 'daily': {
      const m = timeStr.match(/(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
      if (!m) throw new Error('Format: HH:MM (AM/PM)  e.g., 09:00 AM, 14:30');
      const [, hourStr, minute, ampm] = m;
      return { hour: to24Hour(hourStr, ampm), minute: +minute };
    }

    case 'weekly': {
      const m = timeStr.match(/(\w+)\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
      if (!m) throw new Error('Format: DayName HH:MM (AM/PM)  e.g., Monday 09:00 AM');
      const [, dayName, hourStr, minute, ampm] = m;
      const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const day    = dayMap[dayName.toLowerCase()];
      if (day === undefined) throw new Error('Invalid day. Use: Sunday, Monday … Saturday');
      return { day, hour: to24Hour(hourStr, ampm), minute: +minute };
    }

    case 'monthly': {
      const m = timeStr.match(/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?/);
      if (!m) throw new Error('Format: DD HH:MM (AM/PM)  e.g., 15 09:00 AM');
      const [, day, hourStr, minute, ampm] = m;
      if (+day < 1 || +day > 31) throw new Error('Day must be 1–31');
      return { day: +day, hour: to24Hour(hourStr, ampm), minute: +minute };
    }

    default:
      throw new Error(`Unknown reminder type: ${type}`);
  }
}

/**
 * Format stored time components into a human-readable string.
 * @param {'once'|'daily'|'weekly'|'monthly'} type
 * @param {object} t  Parsed time components.
 * @returns {string}
 */
function formatReminderTime(type, t) {
  const fmt = (h, m) => {
    const ampm   = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
  };

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  switch (type) {
    case 'once':
      return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')} ${fmt(t.hour, t.minute)}`;
    case 'daily':
      return `Every day at ${fmt(t.hour, t.minute)}`;
    case 'weekly':
      return `Every ${DAYS[t.day]} at ${fmt(t.hour, t.minute)}`;
    case 'monthly':
      return `${t.day}th of every month at ${fmt(t.hour, t.minute)}`;
    default:
      return 'Unknown schedule';
  }
}

/**
 * Send a standardised error response, picking the right interaction method.
 * Priority: deferred/replied → editReply; else isUpdate → update; else → reply.
 * @param {import('discord.js').Interaction} interaction
 * @param {string}  message
 * @param {boolean} [isUpdate=false]
 * @param {boolean} [v2=false]  Set to true when updating a IS_COMPONENTS_V2 message.
 */
async function sendError(interaction, message, isUpdate = false, v2 = false) {
  try {
    // If the interaction is already deferred or replied (e.g. after deferUpdate),
    // we must use editReply — calling update/reply again would throw 40060/10062.
    if (interaction.deferred || interaction.replied) {
      const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Error').setDescription(message);
      await interaction.editReply({ embeds: [embed], components: [] });
    } else if (isUpdate) {
      if (v2) {
        const container = new ContainerBuilder().setAccentColor(0xFF0000);
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`❌ **Error**\n${message}`)
        );
        await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
      } else {
        const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Error').setDescription(message);
        await interaction.update({ embeds: [embed], components: [] });
      }
    } else {
      const embed = new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Error').setDescription(message);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    logger.error('sendError itself failed', err);
  }
}
