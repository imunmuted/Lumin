/**
 * @fileoverview /birthday command — add, remove and list birthday reminders.
 *               Opens an interactive action picker; scheduling lives in BirthdayScheduler.js.
 * @module commands/birthday/BirthdayHandler
 */

import {
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder
} from 'discord.js';

import { state, saveStateToFile }    from '../../managers/BotManager.js';
import { memorySystem }               from '../../memory/MemorySystem.js';
import * as db                        from '../../database/index.js';
import { Logger }                     from '../../core/Logger.js';
import { SYSTEM_AGENT_CALLSIGN }      from '../../modules/config.js';

const logger = Logger.get('BirthdayHandler');

const MAX_BIRTHDAYS_PER_USER = 5;
const ITEMS_PER_PAGE         = 10;
const MENU_EXPIRY_MS         = 5 * 60 * 1000;

// ============================================================================
// COMMAND DEFINITION
// ============================================================================

export const birthdayCommand = {
  name:        'birthday',
  description: 'Manage birthday reminders.'
};

// ============================================================================
// ENTRY POINT — shows action picker
// ============================================================================

/**
 * @param {import('discord.js').CommandInteraction} interaction
 */
export async function handleBirthdayCommand(interaction) {
  try {
    const container = new ContainerBuilder().setAccentColor(0xFF69B4);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '**🎂 Birthday Manager**\n' +
        'Choose an action below to manage your birthday reminders.'
      )
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('birthday_action_set')
          .setLabel('Set Birthday')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🎂'),
        new ButtonBuilder()
          .setCustomId('birthday_action_remove')
          .setLabel('Remove Birthday')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🗑️'),
        new ButtonBuilder()
          .setCustomId('birthday_action_list')
          .setLabel('List Birthdays')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📅')
      )
    );

    await interaction.reply({
      components: [container],
      flags:      MessageFlags.Ephemeral | IS_COMPONENTS_V2
    });

    setTimeout(() => interaction.deleteReply().catch(() => {}), MENU_EXPIRY_MS);
  } catch (error) {
    logger.error('handleBirthdayCommand failed', error);
    await sendError(interaction, 'Failed to open birthday menu.');
  }
}

// ============================================================================
// ACTION BUTTON HANDLER (Set / Remove / List)
// ============================================================================

/**
 * Handles button presses from the action picker (birthday_action_set/remove/list).
 * Updates the existing ephemeral picker message in place.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleBirthdayActionButton(interaction) {
  const action = interaction.customId.replace('birthday_action_', '');
  try {
    if      (action === 'set')    await showBirthdaySetup(interaction, true);
    else if (action === 'remove') await removeBirthday(interaction, true);
    else if (action === 'list')   await listBirthdays(interaction, 0, true);
  } catch (error) {
    logger.error('handleBirthdayActionButton failed', error);
    await sendError(interaction, 'An error occurred.', true);
  }
}

// ============================================================================
// SELECT MENU HANDLERS
// ============================================================================

/**
 * Month selected → show day pickers.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleBirthdayMonthSelect(interaction) {
  try {
    const month   = interaction.values[0];
    const maxDays = getDaysInMonth(month);

    // Two select menus: days 1-15 and 16-maxDays
    const daySelect1 = new StringSelectMenuBuilder()
      .setCustomId(`birthday_day_${month}_1`)
      .setPlaceholder('Select day (1–15)')
      .addOptions(
        Array.from({ length: 15 }, (_, i) => ({
          label: String(i + 1),
          value: String(i + 1).padStart(2, '0')
        }))
      );

    const daySelect2 = new StringSelectMenuBuilder()
      .setCustomId(`birthday_day_${month}_2`)
      .setPlaceholder(`Select day (16–${maxDays})`)
      .addOptions(
        Array.from({ length: maxDays - 15 }, (_, i) => ({
          label: String(i + 16),
          value: String(i + 16).padStart(2, '0')
        }))
      );

    const container = new ContainerBuilder().setAccentColor(0xFF69B4);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🎂 Birthday Setup — Day**\n` +
        `You selected **${getMonthName(month)}**.\nNow select the day of the month:`
      )
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(daySelect1));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(daySelect2));

    await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
  } catch (error) {
    logger.error('handleBirthdayMonthSelect failed', error);
    await sendError(interaction, 'Failed to update birthday month selection.', true);
  }
}

/**
 * Day selected → ask whose birthday it is.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleBirthdayDaySelect(interaction) {
  try {
    const parts = interaction.customId.split('_');
    const month = parts[2];
    const day   = interaction.values[0];

    const nameSelect = new StringSelectMenuBuilder()
      .setCustomId(`birthday_name_${month}_${day}`)
      .setPlaceholder('Choose whose birthday this is')
      .addOptions(
        { label: 'My Birthday',             value: 'self',  description: 'This is your own birthday',        emoji: '🎂' },
        { label: "Someone Else's Birthday", value: 'other', description: "Track someone else's birthday", emoji: '👥' }
      );

    const container = new ContainerBuilder().setAccentColor(0xFF69B4);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🎂 Birthday Setup — Person's Name**\n` +
        `Birthday: **${getMonthName(month)} ${parseInt(day)}**\n\nWhose birthday is this?`
      )
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(nameSelect));

    await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
  } catch (error) {
    logger.error('handleBirthdayDaySelect failed', error);
    await sendError(interaction, 'Failed to update birthday day selection.', true);
  }
}

/**
 * Name type selected → ask notification preference.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleBirthdayNameSelect(interaction) {
  try {
    const parts    = interaction.customId.split('_');
    const month    = parts[2];
    const day      = parts[3];
    const nameType = interaction.values[0];
    const guildId  = interaction.guild?.id;

    const preferenceSelect = new StringSelectMenuBuilder()
      .setCustomId(`birthday_pref_${month}_${day}_${nameType}`)
      .setPlaceholder('Choose notification preference');

    if (guildId) {
      preferenceSelect.addOptions(
        { label: 'DMs Only',     value: 'dm',     description: 'Receive wishes in direct messages', emoji: '📬' },
        { label: 'Server Only',  value: 'server', description: 'Get celebrated in the server',      emoji: '🎉' },
        { label: 'Both',         value: 'both',   description: 'DM + Server celebration',           emoji: '🎊' }
      );
    } else {
      preferenceSelect.addOptions(
        { label: 'DM', value: 'dm', description: 'Receive wishes in direct messages', emoji: '📬' }
      );
    }

    const container = new ContainerBuilder().setAccentColor(0xFF69B4);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**🎂 Birthday Setup — Notification Preferences**\n` +
        `Birthday: **${getMonthName(month)} ${parseInt(day)}**\n` +
        `For: **${nameType === 'self' ? 'You' : 'Someone else'}**\n\n` +
        `Where should I send birthday notifications?`
      )
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(preferenceSelect));

    await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
  } catch (error) {
    logger.error('handleBirthdayNameSelect failed', error);
    await sendError(interaction, 'Failed to update birthday name selection.', true);
  }
}

/**
 * Preference selected → persist the birthday entry.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleBirthdayPrefSelect(interaction) {
  try {
    const parts      = interaction.customId.split('_');
    const month      = parts[2];
    const day        = parts[3];
    const nameType   = parts[4];
    const preference = interaction.values[0];
    const userId     = interaction.user.id;
    const guildId    = interaction.guild?.id;

    if (!state.birthdays) state.birthdays = {};

    const userBirthdays = Object.keys(state.birthdays).filter(k => k.startsWith(userId)).length;
    if (userBirthdays >= MAX_BIRTHDAYS_PER_USER) {
      const container = new ContainerBuilder().setAccentColor(0xFF5555);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `**❌ Birthday Limit Reached**\nYou have reached the maximum limit of ${MAX_BIRTHDAYS_PER_USER} birthdays.`
        )
      );
      return interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
    }

    const birthdayKey = `${userId}_${month}_${day}`;
    state.birthdays[birthdayKey] = {
      month,
      day,
      preference,
      guildId:       preference !== 'dm' ? guildId : null,
      year:          null,
      nameType,
      ownerUsername: interaction.user.username
    };

    await db.saveBirthday(birthdayKey, state.birthdays[birthdayKey]);
    await saveStateToFile();
    memorySystem.invalidatePersonalDataCache(userId);

    const prefText = { dm: 'DMs only', server: 'this server only', both: 'DMs and this server' }[preference];

    const container = new ContainerBuilder().setAccentColor(0x00C853);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**✅ Birthday Saved!**\n` +
        `Birthday set for **${getMonthName(month)} ${parseInt(day)}**!\n\n` +
        `You'll receive birthday notifications via: **${prefText}** 🎂\n\n` +
        `-# ${userBirthdays + 1}/${MAX_BIRTHDAYS_PER_USER} birthdays set • Change anytime with /birthday`
      )
    );

    await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
  } catch (error) {
    logger.error('handleBirthdayPrefSelect failed', error);
    await sendError(interaction, 'Failed to save birthday preference.', true);
  }
}

/**
 * Birthday chosen for deletion → remove it.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleBirthdayDeleteSelect(interaction) {
  try {
    const birthdayKey = interaction.values[0];

    if (!state.birthdays?.[birthdayKey]) {
      const container = new ContainerBuilder().setAccentColor(0xFF5555);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent('**❌ Birthday Not Found**\nCould not find that birthday.')
      );
      return interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
    }

    const birthday = state.birthdays[birthdayKey];
    delete state.birthdays[birthdayKey];
    await db.deleteBirthday(birthdayKey);
    await saveStateToFile();
    memorySystem.invalidatePersonalDataCache(interaction.user.id);

    const userId    = interaction.user.id;
    const remaining = Object.keys(state.birthdays).filter(k => k.startsWith(userId)).length;

    const container = new ContainerBuilder().setAccentColor(0x00C853);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `**✅ Birthday Removed**\n` +
        `Birthday on **${getMonthName(birthday.month)} ${parseInt(birthday.day)}** has been removed.\n\n` +
        `-# ${remaining}/${MAX_BIRTHDAYS_PER_USER} birthdays remaining`
      )
    );

    await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
  } catch (error) {
    logger.error('handleBirthdayDeleteSelect failed', error);
    await sendError(interaction, 'Failed to delete birthday.', true);
  }
}

// ============================================================================
// PAGINATION BUTTON HANDLERS
// ============================================================================

/**
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleBirthdayListPrev(interaction) {
  try {
    const parts      = interaction.customId.split('_');
    const currentPage = parseInt(parts[3]);
    await interaction.deferUpdate();
    await listBirthdays(interaction, Math.max(0, currentPage - 1));
  } catch (error) {
    logger.error('handleBirthdayListPrev failed', error);
  }
}

/**
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleBirthdayListNext(interaction) {
  try {
    const parts      = interaction.customId.split('_');
    const currentPage = parseInt(parts[3]);
    await interaction.deferUpdate();
    await listBirthdays(interaction, currentPage + 1);
  } catch (error) {
    logger.error('handleBirthdayListNext failed', error);
  }
}

/**
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleBirthdayListJump(interaction) {
  try {
    await interaction.deferUpdate();
    await listBirthdays(interaction, parseInt(interaction.values[0]));
  } catch (error) {
    logger.error('handleBirthdayListJump failed', error);
  }
}

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

const ACCENT_COLOR     = 0xE53935;
const IS_COMPONENTS_V2 = 1 << 15;

/**
 * Show month picker to start the birthday setup flow.
 * @param {import('discord.js').Interaction} interaction
 * @param {boolean} [isUpdate=false]  Use .update() instead of .reply() when called from a button.
 */
async function showBirthdaySetup(interaction, isUpdate = false) {
  try {
    const userId = interaction.user.id;
    if (!state.birthdays) state.birthdays = {};

    const userBirthdays = Object.keys(state.birthdays).filter(k => k.startsWith(userId)).length;
    if (userBirthdays >= MAX_BIRTHDAYS_PER_USER) {
      const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          '**Birthday Limit Reached**\n' +
          `You have reached the maximum of ${MAX_BIRTHDAYS_PER_USER} birthdays.\n` +
          'Remove existing birthdays using `/birthday` → Remove Birthday before adding new ones.'
        )
      );
      if (isUpdate) {
        return interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
      }
      return interaction.reply({
        components: [container],
        flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
      });
    }

    const monthSelect = new StringSelectMenuBuilder()
      .setCustomId('birthday_month')
      .setPlaceholder('Select birth month')
      .addOptions(
        { label: 'January',   value: '01', emoji: '❄️' },
        { label: 'February',  value: '02', emoji: '💝' },
        { label: 'March',     value: '03', emoji: '🌸' },
        { label: 'April',     value: '04', emoji: '🌷' },
        { label: 'May',       value: '05', emoji: '🌺' },
        { label: 'June',      value: '06', emoji: '☀️' },
        { label: 'July',      value: '07', emoji: '🎆' },
        { label: 'August',    value: '08', emoji: '🏖️' },
        { label: 'September', value: '09', emoji: '🍂' },
        { label: 'October',   value: '10', emoji: '🎃' },
        { label: 'November',  value: '11', emoji: '🍁' },
        { label: 'December',  value: '12', emoji: '🎄' }
      );

    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        '**Birthday Setup**\n' +
        `Add a birthday so ${SYSTEM_AGENT_CALLSIGN} can send a celebration message on the day.\n\n` +
        `**Birthdays set:** ${userBirthdays}/${MAX_BIRTHDAYS_PER_USER}\n\n` +
        'Select the birth month to get started:'
      )
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(monthSelect));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('-# Your birthday will never be shared without permission.')
    );

    if (isUpdate) {
      await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
    } else {
      await interaction.reply({
        components: [container],
        flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2
      });
      setTimeout(() => interaction.deleteReply().catch(() => {}), MENU_EXPIRY_MS);
    }

  } catch (error) {
    logger.error('showBirthdaySetup failed', error);
    await sendError(interaction, 'Failed to start birthday setup.', isUpdate);
  }
}

/**
 * Show a delete-picker for the user's own birthdays.
 * @param {import('discord.js').Interaction} interaction
 * @param {boolean} [isUpdate=false]
 */
async function removeBirthday(interaction, isUpdate = false) {
  try {
    const userId = interaction.user.id;
    if (!state.birthdays) state.birthdays = {};

    const userBirthdays = Object.keys(state.birthdays).filter(k => k.startsWith(userId));
    if (userBirthdays.length === 0) {
      const container = new ContainerBuilder().setAccentColor(0xFF5555);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "**❌ No Birthdays Found**\nYou don't have any birthdays set up yet!\n\nUse `/birthday` → Set Birthday to add one."
        )
      );
      if (isUpdate) return interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
      return interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2 });
    }

    const deleteSelect = new StringSelectMenuBuilder()
      .setCustomId('birthday_delete_select')
      .setPlaceholder('Choose birthday to remove')
      .addOptions(
        userBirthdays.slice(0, 25).map(key => {
          const b = state.birthdays[key];
          return {
            label:       `${getMonthName(b.month)} ${parseInt(b.day)}`,
            description: b.nameType === 'self' ? 'Your birthday' : "Someone else's birthday",
            value:       key
          };
        })
      );

    const container = new ContainerBuilder().setAccentColor(0xFF6B6B);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent('**🗑️ Remove Birthday**\nSelect which birthday to remove:')
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addActionRowComponents(new ActionRowBuilder().addComponents(deleteSelect));

    if (isUpdate) {
      await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
    } else {
      await interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2 });
      setTimeout(() => interaction.deleteReply().catch(() => {}), MENU_EXPIRY_MS);
    }

  } catch (error) {
    logger.error('removeBirthday failed', error);
    await sendError(interaction, 'Failed to load birthdays for removal.', isUpdate);
  }
}

/**
 * Render a paginated birthday list.
 * Works for both DMs (own birthdays only) and servers (shared birthdays).
 * @param {import('discord.js').Interaction} interaction
 * @param {number}  [page=0]      Zero-based page index.
 * @param {boolean} [isUpdate=false]  Use .update() for button-triggered calls.
 */
async function listBirthdays(interaction, page = 0, isUpdate = false) {
  try {
    const userId  = interaction.user.id;
    const guildId = interaction.guild?.id;
    const isDM    = !guildId;

    const makeEmptyContainer = (text) => {
      const c = new ContainerBuilder().setAccentColor(0xFF5555);
      c.addTextDisplayComponents(new TextDisplayBuilder().setContent(text));
      return c;
    };

    const sendContainer = async (container, comps = []) => {
      // Attach any ActionRows to the container
      for (const row of comps) container.addActionRowComponents(row);
      if (isUpdate) {
        await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
      } else {
        const replyMethod = interaction.replied || interaction.deferred ? 'editReply' : 'reply';
        const flags = interaction.deferred ? IS_COMPONENTS_V2 : MessageFlags.Ephemeral | IS_COMPONENTS_V2;
        await interaction[replyMethod]({ components: [container], flags });
      }
    };

    if (!state.birthdays || Object.keys(state.birthdays).length === 0) {
      return sendContainer(makeEmptyContainer(
        '**📅 No Birthdays**\nNo birthdays have been set yet!\n\nBe the first with `/birthday` → Set Birthday'
      ));
    }

    if (isDM) {
      // ---------- DM view: only the caller's own birthdays ----------
      const userBirthdays = Object.entries(state.birthdays)
        .filter(([key]) => key.startsWith(userId))
        .map(([, data]) => ({
          month:      data.month,
          day:        data.day,
          monthNum:   parseInt(data.month),
          nameType:   data.nameType,
          preference: data.preference
        }))
        .sort((a, b) => a.monthNum - b.monthNum || parseInt(a.day) - parseInt(b.day));

      if (userBirthdays.length === 0) {
        return sendContainer(makeEmptyContainer(
          "**📅 No Birthdays**\nYou haven't set any birthdays yet.\n\nUse `/birthday` → Set Birthday to add one!"
        ));
      }

      const list = userBirthdays
        .map(b => {
          const forWhom  = b.nameType === 'self' ? 'You' : 'Someone else';
          const location = b.preference === 'dm' ? 'DMs' : b.preference === 'both' ? 'DMs & Server' : 'Server';
          return `🎂 **${getMonthName(b.month)} ${parseInt(b.day)}** — ${forWhom} (${location})`;
        })
        .join('\n');

      const container = new ContainerBuilder().setAccentColor(0xFF69B4);
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**🎉 Your Birthdays**\n\n${list}`)
      );
      container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${userBirthdays.length}/${MAX_BIRTHDAYS_PER_USER} birthdays set`)
      );
      return sendContainer(container);
    }

    // ---------- Server view: paginated, shared birthdays ----------
    const today        = new Date();
    const currentMonth = today.getMonth() + 1;
    const currentDay   = today.getDate();

    const all = Object.values(state.birthdays)
      .filter(d => d.guildId === guildId && (d.preference === 'server' || d.preference === 'both'))
      .map(d => ({ username: d.ownerUsername ?? 'User', month: d.month, day: d.day, monthNum: parseInt(d.month) }));

    if (all.length === 0) {
      return sendContainer(makeEmptyContainer(
        '**📅 No Server Birthdays**\nNo birthdays are set to be celebrated in this server.'
      ));
    }

    // Sort: upcoming first, wrap around past
    const upcoming = all.filter(b =>
      b.monthNum > currentMonth || (b.monthNum === currentMonth && parseInt(b.day) >= currentDay)
    ).sort((a, b) => a.monthNum - b.monthNum || parseInt(a.day) - parseInt(b.day));

    const past = all.filter(b =>
      b.monthNum < currentMonth || (b.monthNum === currentMonth && parseInt(b.day) < currentDay)
    ).sort((a, b) => a.monthNum - b.monthNum || parseInt(a.day) - parseInt(b.day));

    const sorted     = [...upcoming, ...past];
    const totalPages = Math.ceil(sorted.length / ITEMS_PER_PAGE);
    const safePage   = Math.max(0, Math.min(page, totalPages - 1));
    const pageItems  = sorted.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE);

    const list = pageItems
      .map(b => `🎂 **${b.username}** — ${getMonthName(b.month)} ${parseInt(b.day)}`)
      .join('\n');

    const container = new ContainerBuilder().setAccentColor(0xFF69B4);
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**🎉 Server Birthdays**\n\n${list}`)
    );
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        `-# Page ${safePage + 1}/${totalPages} • ${sorted.length} birthday${sorted.length !== 1 ? 's' : ''} registered`
      )
    );

    const paginationRows = [];

    if (totalPages > 1) {
      const prevBtn = new ButtonBuilder()
        .setCustomId(`birthday_list_prev_${safePage}_${guildId}`)
        .setLabel('Previous').setStyle(ButtonStyle.Primary).setEmoji('⬅️')
        .setDisabled(safePage === 0);

      const nextBtn = new ButtonBuilder()
        .setCustomId(`birthday_list_next_${safePage}_${guildId}`)
        .setLabel('Next').setStyle(ButtonStyle.Primary).setEmoji('➡️')
        .setDisabled(safePage === totalPages - 1);

      paginationRows.push(new ActionRowBuilder().addComponents(prevBtn, nextBtn));

      if (totalPages > 3) {
        const pageSelect = new StringSelectMenuBuilder()
          .setCustomId(`birthday_list_jump_${guildId}`)
          .setPlaceholder(`Jump to page… (${safePage + 1}/${totalPages})`)
          .addOptions(
            Array.from({ length: Math.min(totalPages, 25) }, (_, i) => ({
              label:       `Page ${i + 1}`,
              value:       String(i),
              description: `Show birthdays ${i * ITEMS_PER_PAGE + 1}–${Math.min((i + 1) * ITEMS_PER_PAGE, sorted.length)}`,
              default:     i === safePage
            }))
          );
        paginationRows.push(new ActionRowBuilder().addComponents(pageSelect));
      }
    }

    await sendContainer(container, paginationRows);

    // Auto-expire pagination buttons
    if (paginationRows.length > 0) {
      setTimeout(async () => {
        try {
          const msg = await interaction.fetchReply();
          if (msg?.components.length > 0) {
            const stripped = new ContainerBuilder().setAccentColor(0xFF69B4);
            stripped.addTextDisplayComponents(
              new TextDisplayBuilder().setContent(`**🎉 Server Birthdays**\n\n${list}`)
            );
            await interaction.editReply({ components: [stripped], flags: IS_COMPONENTS_V2 }).catch(() => {});
          }
        } catch {}
      }, MENU_EXPIRY_MS);
    }

  } catch (error) {
    logger.error('listBirthdays failed', error);
    await sendError(interaction, 'Failed to list birthdays.', isUpdate);
  }
}

/**
 * Send a standardised error response.
 * @param {import('discord.js').Interaction} interaction
 * @param {string}  message
 * @param {boolean} [isUpdate=false]  Use interaction.update() instead of reply/editReply.
 */
async function sendError(interaction, message, isUpdate = false) {
  const container = new ContainerBuilder().setAccentColor(0xFF0000);
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(`**❌ Error**\n${message}`)
  );

  try {
    if (isUpdate) {
      await interaction.update({ components: [container], flags: IS_COMPONENTS_V2 });
    } else if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ components: [container], flags: IS_COMPONENTS_V2 });
    } else {
      await interaction.reply({ components: [container], flags: MessageFlags.Ephemeral | IS_COMPONENTS_V2 });
    }
  } catch (err) {
    logger.error('sendError itself failed', err);
  }
}

// ============================================================================
// PURE UTILITIES
// ============================================================================

/** Max days in a given two-digit month string (e.g. '02' → 29). */
function getDaysInMonth(month) {
  const m = parseInt(month);
  if (m === 2)                       return 29;
  if ([4, 6, 9, 11].includes(m))    return 30;
  return 31;
}

/** Convert a two-digit month string to its full name. */
export function getMonthName(monthNum) {
  if (!monthNum) return 'Unknown Month';
  const months = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
  ];
  return months[parseInt(monthNum) - 1] ?? 'Unknown Month';
}
