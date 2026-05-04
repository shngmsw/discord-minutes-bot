import {
  ChannelType,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { sessionManager } from '../recording/session-manager.js';
import { logger } from '../util/logger.js';
import type { SlashCommand } from './index.js';

const data = new SlashCommandBuilder()
  .setName('record')
  .setDescription('ボイスチャネルの会話を録音し議事録を生成します')
  .addSubcommand((sub) =>
    sub.setName('start').setDescription('発行者の参加中ボイスチャネルで録音を開始します'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('snapshot')
      .setDescription('録音継続したまま、ここまでの中間サマリを投稿します'),
  )
  .addSubcommand((sub) =>
    sub.setName('stop').setDescription('録音を停止し、文字起こしと議事録を投稿します'),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'このコマンドはサーバー内でのみ使えます。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand(true);
  if (sub === 'start') {
    await handleStart(interaction);
    return;
  }
  if (sub === 'snapshot') {
    await handleSnapshot(interaction);
    return;
  }
  if (sub === 'stop') {
    await handleStop(interaction);
    return;
  }
}

async function handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  logger.info(
    {
      guildId,
      userId: interaction.user.id,
      hasGuild: !!interaction.guild,
      hasMember: !!interaction.member,
    },
    '/record start invoked',
  );

  if (!guildId) {
    await interaction.reply({
      content: 'サーバー情報を取得できませんでした (no guildId)。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let guild = interaction.guild;
  if (!guild) {
    try {
      guild = await interaction.client.guilds.fetch(guildId);
    } catch (err) {
      logger.error({ err, guildId }, 'guild fetch failed');
      await interaction.reply({
        content: `サーバー取得失敗: ${err instanceof Error ? err.message : String(err)}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  let member;
  try {
    member = await guild.members.fetch(interaction.user.id);
  } catch (err) {
    logger.error({ err, userId: interaction.user.id }, 'member fetch failed');
    await interaction.reply({
      content: `メンバー取得失敗: ${err instanceof Error ? err.message : String(err)}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  logger.info(
    {
      voiceChannelId: member.voice.channelId,
      voiceChannelType: member.voice.channel?.type,
    },
    'member voice state',
  );

  const voiceChannel = member.voice.channel;
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: '先にボイスチャネルに参加してから実行してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const textChannel = interaction.channel;
  if (!textChannel || !('send' in textChannel) || !('guild' in textChannel)) {
    await interaction.reply({
      content: 'このチャネルには議事録を投稿できません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sessionManager.has(interaction.guildId!)) {
    await interaction.reply({
      content: 'このサーバーでは既に録音中です。先に `/record stop` で停止してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  try {
    await sessionManager.start({
      guildId: interaction.guildId!,
      voiceChannel,
      textChannel,
      requesterTag: member.user.tag,
    });
    await interaction.editReply(
      `🔴 録音を開始しました（${voiceChannel.name}）。停止するには \`/record stop\` を実行してください。`,
    );
  } catch (err) {
    logger.error({ err }, 'failed to start recording');
    await interaction.editReply(
      `録音開始に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleSnapshot(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!sessionManager.has(interaction.guildId!)) {
    await interaction.reply({
      content: '現在録音していません。先に `/record start` を実行してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  try {
    await interaction.editReply('📌 中間サマリを生成中…（録音は継続中）');
    await sessionManager.snapshot(interaction.guildId!);
  } catch (err) {
    logger.error({ err }, 'snapshot failed');
    await interaction
      .followUp({
        content: `中間サマリ生成中にエラー: ${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => undefined);
  }
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!sessionManager.has(interaction.guildId!)) {
    await interaction.reply({
      content: '現在録音していません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  try {
    await interaction.editReply('⏹️ 録音を停止しました。文字起こしと議事録を生成中…');
    await sessionManager.stop(interaction.guildId!);
  } catch (err) {
    logger.error({ err }, 'failed to stop recording');
    await interaction
      .followUp({
        content: `処理中にエラーが発生しました: ${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => undefined);
  }
}

export const record: SlashCommand = { data, execute };
