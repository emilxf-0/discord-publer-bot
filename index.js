require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, ApplicationCommandType, MessageFlags, Events } = require('discord.js');
const { getWorkspaceAndAccounts, uploadMediaFromUrls, createIdea } = require('./publer');

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

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register the context menu command
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const command = {
    name: 'Forward to Publer',
    type: ApplicationCommandType.Message,
  };

  try {
    const data = await rest.put(
      Routes.applicationGuildCommands(client.user.id, process.env.GUILD_ID),
      { body: [command] }
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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isMessageContextMenuCommand()) return;
  if (interaction.commandName !== 'Forward to Publer') return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = interaction.targetMessage;

  try {
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
});

client.login(process.env.DISCORD_TOKEN);