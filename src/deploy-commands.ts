import { REST, Routes } from 'discord.js';
import { commands } from './commands/index.js';
import { config } from './config.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'guild';
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);
  const body = Object.values(commands).map((c) => c.data.toJSON());

  if (mode === 'global') {
    logger.info('deploying global commands…');
    await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), { body });
    logger.info('global commands deployed (反映に最大1時間)');
    return;
  }

  if (!config.DISCORD_GUILD_ID) {
    throw new Error('DISCORD_GUILD_ID が未設定です（guild モード）');
  }
  logger.info({ guildId: config.DISCORD_GUILD_ID }, 'deploying guild commands…');
  await rest.put(
    Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
    { body },
  );
  logger.info('guild commands deployed');
}

main().catch((err) => {
  logger.error({ err }, 'deploy failed');
  process.exit(1);
});
