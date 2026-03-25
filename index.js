require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ApplicationCommandType,
  MessageFlags,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} = require('discord.js');
const chrono = require('chrono-node');
const { getWorkspaceAndAccounts, uploadMediaFromUrls, createIdea, publishImmediately, schedulePost } = require('./publer');

if (!process.env.DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN is missing in .env');
  process.exit(1);
}
if (!process.env.GUILD_ID) {
  console.error('Error: GUILD_ID is missing in .env (right-click your server icon → Copy Server ID)');
  process.exit(1);
}
if (!process.env.PUBLER_API_KEY) {
  console.error('Error: PUBLER_API_KEY is missing in .env');
  process.exit(1);
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);
const VIDEO_CONTENT_TYPES = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska'];

function isImageAttachment(attachment) {
  if (attachment.contentType && IMAGE_CONTENT_TYPES.includes(attachment.contentType)) return true;
  const ext = (attachment.name || '').split('.').pop()?.toLowerCase();
  return ext && IMAGE_EXTENSIONS.has(ext);
}

function isVideoAttachment(attachment) {
  if (attachment.contentType && VIDEO_CONTENT_TYPES.includes(attachment.contentType)) return true;
  const ext = (attachment.name || '').split('.').pop()?.toLowerCase();
  return ext && VIDEO_EXTENSIONS.has(ext);
}

function extractMessageData(message) {
  const text = message.content?.trim() || '';
  const imageAttachments = [...message.attachments.values()].filter(isImageAttachment);
  const videoAttachments = [...message.attachments.values()].filter(isVideoAttachment);
  const embedImages = message.embeds
    ?.filter((e) => e.image?.url || e.thumbnail?.url)
    .flatMap((e) => [
      e.image?.url && { url: e.image.url, name: 'embed-image.png', type: 'image' },
      e.thumbnail?.url && { url: e.thumbnail.url, name: 'embed-thumb.png', type: 'image' },
    ])
    .filter(Boolean) ?? [];
  const embedVideos = message.embeds
    ?.filter((e) => e.video?.url)
    .map((e) => ({ url: e.video.url, name: 'embed-video.mp4', type: 'video' })) ?? [];

  const mediaItems = [
    ...imageAttachments.map((a) => ({ url: a.url, name: a.name, type: 'image' })),
    ...videoAttachments.map((a) => ({ url: a.url, name: a.name, type: 'video' })),
    ...embedImages,
    ...embedVideos,
  ];

  return { text, mediaItems };
}

/** Map timezone abbreviations to IANA for display (toLocaleString needs IANA) */
const TZ_ABBR_TO_IANA = {
  cet: 'Europe/Stockholm',
  cest: 'Europe/Stockholm',
  est: 'America/New_York',
  edt: 'America/New_York',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  gmt: 'Europe/London',
  bst: 'Europe/London',
  utc: 'UTC',
};

function formatScheduledTime(isoString) {
  const tz = process.env.PUBLER_SCHEDULE_TIMEZONE?.trim();
  const tzDisplay = tz ? (TZ_ABBR_TO_IANA[tz.toLowerCase()] || tz) : 'UTC';
  return new Date(isoString).toLocaleString(undefined, { timeZone: tzDisplay });
}

function parseScheduleTime(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  const tz = process.env.PUBLER_SCHEDULE_TIMEZONE?.trim() || null;
  const ref = tz ? { instant: new Date(), timezone: tz } : new Date();
  const result = chrono.parseDate(trimmed, ref, { forwardDate: true });
  if (!result) return null;
  const minFuture = Date.now() + 60 * 1000; // Publer: at least 1 min in future
  if (result.getTime() < minFuture) return null;
  return result.toISOString();
}

const DEFAULT_FOLLOWUP_ECLIPSIUM =
  'Get it on steam https://store.steampowered.com/app/2419670/Eclipsium/';
const DEFAULT_FOLLOWUP_HAULKING =
  'Wishlist on steam https://store.steampowered.com/app/4373420/All_Haul_the_King/';

/** @returns {string | null} Error message, or null if valid */
function validateFollowUpPreset(raw) {
  const p = (raw || '').trim().toLowerCase();
  if (!p) return null;
  if (p === '1' || p === '2') return null;
  return 'Follow-up preset must be **1**, **2**, or left blank.';
}

function resolveScheduleFollowUp(presetRaw, textRaw) {
  const p = (presetRaw || '').trim().toLowerCase();
  if (!p) return null;
  const custom = (textRaw || '').trim();
  if (custom) return custom;
  if (p === '1') return DEFAULT_FOLLOWUP_ECLIPSIUM;
  if (p === '2') return DEFAULT_FOLLOWUP_HAULKING;
  return null;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const commands = [
    { name: 'Forward to Publer', type: ApplicationCommandType.Message },
    { name: 'YOLO Publish to Twitter', type: ApplicationCommandType.Message },
    { name: 'YOLO Publish to all', type: ApplicationCommandType.Message },
    { name: 'Schedule to all', type: ApplicationCommandType.Message },
  ];

  try {
    const data = await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: commands }
    );
    console.log(`Registered ${data.length} command(s)`);
  } catch (error) {
    console.error('Failed to register command:', error);
    if (error.code === 50001) {
      console.error('Missing "applications.commands" scope. Re-invite the bot with that scope:');
      console.error('https://discord.com/developers/applications → OAuth2 → URL Generator → scopes: bot + applications.commands');
    }
  }
});

async function showPublishModal(interaction, commandType, defaultText, channelId, messageId) {
  const modal = new ModalBuilder()
    .setCustomId(`${commandType}::${channelId}::${messageId}`)
    .setTitle(commandType === 'schedule-all' ? 'Schedule post' : 'Edit & publish');

  const textInput = new TextInputBuilder()
    .setCustomId('post-text')
    .setLabel('Post content')
    .setStyle(TextInputStyle.Paragraph)
    .setValue(defaultText || '(no caption)')
    .setRequired(true)
    .setMaxLength(4000);

  if (commandType === 'schedule-all') {
    const tzHint = process.env.PUBLER_SCHEDULE_TIMEZONE?.trim() || 'server time';
    const timeInput = new TextInputBuilder()
      .setCustomId('schedule-time')
      .setLabel('When to post')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder(`tomorrow 9am, Mon 14:00, 2025-06-01 09:00 (${tzHint})`)
      .setRequired(true);
    const followupPreset = new TextInputBuilder()
      .setCustomId('followup-preset')
      .setLabel('Steam follow-up (1 or 2)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('1=Eclipsium, 2=Wishlist, blank=none')
      .setRequired(false)
      .setMaxLength(10);
    const followupText = new TextInputBuilder()
      .setCustomId('followup-text')
      .setLabel('Follow-up text (optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Override preset text; leave blank for default')
      .setRequired(false)
      .setMaxLength(4000);
    modal.addComponents(
      new ActionRowBuilder().addComponents(textInput),
      new ActionRowBuilder().addComponents(timeInput),
      new ActionRowBuilder().addComponents(followupPreset),
      new ActionRowBuilder().addComponents(followupText)
    );
  } else {
    modal.addComponents(new ActionRowBuilder().addComponents(textInput));
  }

  await interaction.showModal(modal);
}

async function executePublish(interaction, { text, mediaItems }, commandType, extra = {}) {
  try {
    if (mediaItems.length === 0 && !text) {
      await interaction.editReply('No text or media to publish.');
      return;
    }

    await interaction.editReply('Connecting to Publer...');
    const { workspaceId } = await getWorkspaceAndAccounts();

    let mediaResult = { ids: [], types: [] };
    if (mediaItems.length > 0) {
      await interaction.editReply('Uploading to Publer...');
      mediaResult = await uploadMediaFromUrls(mediaItems, workspaceId);
    }

    if (commandType === 'publish-twitter') {
      await interaction.editReply('Publishing to Twitter...');
      const { accountCount } = await publishImmediately(text, mediaResult, 'twitter');
      await interaction.editReply(`✓ Published to Twitter!`);
    } else if (commandType === 'publish-all') {
      await interaction.editReply('Publishing to all channels...');
      const { accountCount } = await publishImmediately(text, mediaResult, null);
      await interaction.editReply(`✓ Published to ${accountCount} channel(s)!`);
    } else if (commandType === 'schedule-all') {
      const scheduledAt = extra.scheduledAt;
      if (!scheduledAt) {
        const tzHint = process.env.PUBLER_SCHEDULE_TIMEZONE?.trim() || 'server time';
        await interaction.editReply(`Could not parse that date/time. Try "tomorrow 9am", "Mon 14:00", or "2025-06-01 09:00". Times are in ${tzHint}. Must be 1+ min in future.`);
        return;
      }
      await interaction.editReply('Scheduling...');
      const scheduleOpts = extra.followUpText ? { followUpText: extra.followUpText } : {};
      const result = await schedulePost(text, mediaResult, scheduledAt, scheduleOpts);
      const timeStr = formatScheduledTime(scheduledAt);
      let reply =
        `✓ Scheduled for ${timeStr} on ${result.accountCount} channel(s)!\n\nView in **Calendar**: https://app.publer.com/#/calendar`;
      if (result.followUpRequested) {
        const th = result.followUpThreshold ?? 1000;
        if (result.followUpAccountCount > 0) {
          reply += `\n\n**Follow-up** (Publer: when reach **or** engagement > ${th}): ${result.followUpAccountCount} account(s).`;
        } else {
          reply +=
            '\n\nFollow-up was set, but **no connected account** supports Publer follow-up comments (X, LinkedIn, Facebook Page, Mastodon, Threads, Bluesky).';
        }
      }
      await interaction.editReply(reply);
    }
  } catch (err) {
    console.error('Publer error:', err);
    await interaction.editReply(`Failed: ${err.message}`).catch(() => {});
  }
}

client.on('interactionCreate', async (interaction) => {
  if (interaction.isMessageContextMenuCommand()) {
    const message = interaction.targetMessage;
    const { text, mediaItems } = extractMessageData(message);

    if (interaction.commandName === 'Forward to Publer') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        if (mediaItems.length === 0 && !text) {
          await interaction.editReply('No text or media to forward.');
          return;
        }
        await interaction.editReply('Connecting to Publer...');
        const { workspaceId } = await getWorkspaceAndAccounts();
        let mediaResult = { ids: [], types: [] };
        if (mediaItems.length > 0) {
          await interaction.editReply('Uploading to Publer...');
          mediaResult = await uploadMediaFromUrls(mediaItems, workspaceId);
        }
        await interaction.editReply('Creating idea in Publer...');
        await createIdea(text, mediaResult, workspaceId);
        await interaction.editReply(
          `✓ Idea created!\n\nGo to **Ideas** in Publer to choose channels and schedule: https://app.publer.com/#/ideas`
        );
      } catch (err) {
        console.error('Publer error:', err);
        await interaction.editReply(`Failed: ${err.message}`).catch(() => {});
      }
      return;
    }

    if (interaction.commandName === 'YOLO Publish to Twitter') {
      if (mediaItems.length === 0 && !text) {
        await interaction.reply({ content: 'No text or media to publish.', flags: MessageFlags.Ephemeral });
        return;
      }
      await showPublishModal(interaction, 'publish-twitter', text, message.channelId, message.id);
      return;
    }

    if (interaction.commandName === 'YOLO Publish to all') {
      if (mediaItems.length === 0 && !text) {
        await interaction.reply({ content: 'No text or media to publish.', flags: MessageFlags.Ephemeral });
        return;
      }
      await showPublishModal(interaction, 'publish-all', text, message.channelId, message.id);
      return;
    }

    if (interaction.commandName === 'Schedule to all') {
      if (mediaItems.length === 0 && !text) {
        await interaction.reply({ content: 'No text or media to schedule.', flags: MessageFlags.Ephemeral });
        return;
      }
      await showPublishModal(interaction, 'schedule-all', text, message.channelId, message.id);
      return;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.replied || interaction.deferred) return;

    const parts = interaction.customId.split('::');
    const [commandType, channelId, messageId] = parts;
    if (!channelId || !messageId) {
      await interaction.reply({ content: 'Invalid form. Right-click the message and try again.', flags: MessageFlags.Ephemeral });
      return;
    }

    let message;
    try {
      const channel = await client.channels.fetch(channelId);
      message = await channel.messages.fetch(messageId);
    } catch (err) {
      await interaction.reply({
        content: 'Could not load the message (it may have been deleted). Right-click the message and try again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const { text, mediaItems } = extractMessageData(message);
    const editedText = interaction.fields.getTextInputValue('post-text') || text;
    const extra = {};
    if (commandType === 'schedule-all') {
      const presetErr = validateFollowUpPreset(interaction.fields.getTextInputValue('followup-preset') || '');
      if (presetErr) {
        await interaction.reply({ content: presetErr, flags: MessageFlags.Ephemeral });
        return;
      }
      const timeInput = interaction.fields.getTextInputValue('schedule-time') || '';
      extra.scheduledAt = parseScheduleTime(timeInput);
      extra.followUpText = resolveScheduleFollowUp(
        interaction.fields.getTextInputValue('followup-preset') || '',
        interaction.fields.getTextInputValue('followup-text') || ''
      );
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      if (err.code === 40060) return; // Already acknowledged
      throw err;
    }
    await executePublish(interaction, { text: editedText, mediaItems }, commandType, extra);
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
