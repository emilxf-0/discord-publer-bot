#!/usr/bin/env node
/**
 * Quick check: verifies env vars and that the bot can register commands.
 * Run: node check.js
 */
require('dotenv').config();

const missing = [];
if (!process.env.DISCORD_TOKEN) missing.push('DISCORD_TOKEN');
if (!process.env.GUILD_ID) missing.push('GUILD_ID');

if (missing.length) {
  console.error('Missing in .env:', missing.join(', '));
  process.exit(1);
}

console.log('✓ DISCORD_TOKEN set');
console.log('✓ GUILD_ID set:', process.env.GUILD_ID);

const { REST, Routes } = require('discord.js');

async function check() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    const apps = await rest.get(Routes.oauth2CurrentApplication());
    console.log('✓ Bot app:', apps.name);
    const cmds = await rest.get(
      Routes.applicationGuildCommands(apps.id, process.env.GUILD_ID)
    );
    console.log('✓ Guild commands:', cmds.length);
    cmds.forEach((c) => console.log('  -', c.name, `(type: ${c.type})`));
  } catch (err) {
    console.error('✗', err.message);
    process.exit(1);
  }
}

check();
