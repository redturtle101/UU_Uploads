const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');

const config = require('./config.json');
const parser = new Parser();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const SEEN_FILE    = path.join(__dirname, 'seen_videos.json');
const MEMBERS_FILE = path.join(__dirname, 'members.json');

// ─── Persistence helpers ─────────────────────────────────────────────────────

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function loadMembers() {
  try { return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')); }
  catch { return [config.ownerId]; }
}

function saveMembers(members) {
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
}

// ─── YouTube helpers ─────────────────────────────────────────────────────────

function buildEmbed(item, channelName, isTest = false) {
  const videoId = item.link?.split('v=')[1];
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setAuthor({ name: channelName, iconURL: 'https://cdn-icons-png.flaticon.com/512/1384/1384060.png' })
    .setTitle(`${isTest ? '[TEST] ' : ''}${item.title || 'New Video'}`)
    .setURL(item.link || '')
    .setDescription(isTest
      ? `**${channelName}** — this is a test notification!`
      : `**${channelName}** just uploaded a new video!`)
    .setThumbnail(videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null)
    .setFooter({ text: `YouTube Notifier${isTest ? ' • Test' : ''}` })
    .setTimestamp(isTest ? new Date() : (item.pubDate ? new Date(item.pubDate) : new Date()));
}

async function checkChannel(channelId, channelName, seen) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch (err) {
    console.error(`[${channelName}] Failed to fetch RSS:`, err.message);
    return [];
  }

  const newVideos = [];
  for (const item of feed.items.slice(0, 5)) {
    const videoId = item.id?.split(':').pop() || item.link;
    if (!seen[channelId]) seen[channelId] = [];
    if (!seen[channelId].includes(videoId)) {
      seen[channelId].push(videoId);
      if (seen[channelId].length > 50) seen[channelId].shift();
      newVideos.push({ item, channelName });
    }
  }
  return newVideos;
}

async function dmMembers(embeds) {
  const members = loadMembers();
  for (const userId of members) {
    let user;
    try { user = await client.users.fetch(userId); }
    catch { console.error(`Could not fetch user ${userId}`); continue; }

    for (const embed of embeds) {
      try {
        await user.send({ embeds: [embed] });
        console.log(`[DM Sent → ${user.tag}] ${embed.data.title}`);
      } catch (err) {
        console.error(`Failed to DM ${userId}:`, err.message);
      }
    }
  }
}

async function runChecks(isStartup = false) {
  const seen = loadSeen();
  const allNew = [];

  for (const { id, name } of config.youtubers) {
    const results = await checkChannel(id, name, seen);
    allNew.push(...results);
  }
  saveSeen(seen);

  if (isStartup) {
    console.log(`[Startup] Seeded ${Object.keys(seen).length} channels. Watching for new uploads...`);
    return;
  }

  if (allNew.length === 0) return;
  const embeds = allNew.map(({ item, channelName }) => buildEmbed(item, channelName));
  await dmMembers(embeds);
}

// ─── Slash command definitions ────────────────────────────────────────────────

const slashCommands = [
  new SlashCommandBuilder()
    .setName('addme')
    .setDescription('Subscribe to YouTube upload notifications'),

  new SlashCommandBuilder()
    .setName('removeme')
    .setDescription('Unsubscribe from YouTube upload notifications'),

  new SlashCommandBuilder()
    .setName('members')
    .setDescription('List all subscribed members (owner only)'),

  new SlashCommandBuilder()
    .setName('test')
    .setDescription('Send yourself a test DM with the latest video from each channel'),
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.token);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), {
      body: slashCommands.map(cmd => cmd.toJSON()),
    });
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
}

// ─── Slash command handlers ───────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  if (commandName === 'addme') {
    const members = loadMembers();
    if (members.includes(user.id)) {
      return interaction.reply({ content: 'You\'re already subscribed! 👍', ephemeral: true });
    }
    members.push(user.id);
    saveMembers(members);
    interaction.reply({ content: '✅ Subscribed! You\'ll get a DM whenever a new video drops.', ephemeral: true });
  }

  else if (commandName === 'removeme') {
    let members = loadMembers();
    if (!members.includes(user.id)) {
      return interaction.reply({ content: 'You\'re not subscribed.', ephemeral: true });
    }
    if (user.id === config.ownerId && members.length === 1) {
      return interaction.reply({ content: '⚠️ You\'re the only member — add someone else first.', ephemeral: true });
    }
    members = members.filter(id => id !== user.id);
    saveMembers(members);
    interaction.reply({ content: '✅ Unsubscribed.', ephemeral: true });
  }

  else if (commandName === 'members') {
    if (user.id !== config.ownerId) {
      return interaction.reply({ content: '❌ Only the owner can use this.', ephemeral: true });
    }
    const members = loadMembers();
    if (members.length === 0) {
      return interaction.reply({ content: 'No members yet.', ephemeral: true });
    }
    const lines = await Promise.all(members.map(async (id) => {
      try {
        const u = await client.users.fetch(id);
        return `• ${u.tag} (\`${id}\`)${id === config.ownerId ? ' 👑' : ''}`;
      } catch {
        return `• Unknown (\`${id}\`)`;
      }
    }));
    interaction.reply({ content: `**Subscribed members (${members.length}):**\n${lines.join('\n')}`, ephemeral: true });
  }

  else if (commandName === 'test') {
    await interaction.reply({ content: 'Sending you a test DM for each channel...', ephemeral: true });
    const caller = await client.users.fetch(user.id);
    for (const { id, name } of config.youtubers) {
      let feed;
      try {
        feed = await parser.parseURL(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
      } catch (err) {
        await interaction.followUp({ content: `❌ Failed to fetch **${name}**: ${err.message}`, ephemeral: true });
        continue;
      }
      const item = feed.items[0];
      if (!item) continue;
      await caller.send({ embeds: [buildEmbed(item, name, true)] });
    }
    await interaction.followUp({ content: '✅ Done! Check your DMs.', ephemeral: true });
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`📺 Watching ${config.youtubers.length} channel(s)`);
  console.log(`👥 Notifying ${loadMembers().length} member(s)`);

  await registerCommands();
  await runChecks(true);
  setInterval(() => runChecks(false), config.checkIntervalMinutes * 60 * 1000);
});

client.login(config.token);
