import { Client, Events, GatewayIntentBits } from 'discord.js';
import { commands } from './commands/index.js';
import { config } from './config.js';
import { sessionManager } from './recording/session-manager.js';
import { logger } from './util/logger.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) => {
  const guilds = c.guilds.cache.map((g) => ({ id: g.id, name: g.name }));
  logger.info({ tag: c.user.tag, guildCount: guilds.length, guilds }, 'logged in');
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands[interaction.commandName];
  if (!command) return;
  try {
    await command.execute(interaction);
  } catch (err) {
    logger.error({ err, command: interaction.commandName }, 'command execution failed');
    const reply = {
      content: '内部エラーが発生しました。',
      flags: 64,
    } as const;
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(reply).catch(() => undefined);
    } else {
      await interaction.reply(reply).catch(() => undefined);
    }
  }
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  await sessionManager.stopAll().catch((err) => logger.error({ err }, 'stopAll failed'));
  client.destroy().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

client.login(config.DISCORD_TOKEN);
