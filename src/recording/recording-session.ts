import { unlink } from 'node:fs/promises';
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import type { GuildBasedChannel, TextBasedChannel, VoiceChannel } from 'discord.js';
import {
  mergeTranscripts,
  type MergedSegment,
  type SpeakerTranscript,
} from '../transcription/merge-transcripts.js';
import { transcribeSpeaker } from '../transcription/transcribe.js';
import { generateMinutes } from '../minutes/generate-minutes.js';
import { postMinutes } from '../discord/post-minutes.js';
import { createSessionTempDir, removeDir } from '../util/tempdir.js';
import { logger } from '../util/logger.js';
import { SpeakerRecorder } from './speaker-recorder.js';

export interface RecordingSessionInit {
  guildId: string;
  voiceChannel: VoiceChannel;
  textChannel: GuildBasedChannel & TextBasedChannel;
  requesterTag: string;
}

export class RecordingSession {
  readonly guildId: string;
  readonly voiceChannel: VoiceChannel;
  readonly textChannel: GuildBasedChannel & TextBasedChannel;
  readonly requesterTag: string;
  private connection: VoiceConnection | null = null;
  private sessionDir: string | null = null;
  private recorders = new Map<string, SpeakerRecorder>();
  private startedAt = 0;
  private stopped = false;
  /** 既にトランスクライブ済みの過去チャンク（時系列に append される） */
  private accumulator: MergedSegment[] = [];
  /** snapshot/stop の直列化用 mutex */
  private mutex: Promise<void> = Promise.resolve();

  constructor(init: RecordingSessionInit) {
    this.guildId = init.guildId;
    this.voiceChannel = init.voiceChannel;
    this.textChannel = init.textChannel;
    this.requesterTag = init.requesterTag;
  }

  async start(): Promise<void> {
    this.sessionDir = await createSessionTempDir();
    this.startedAt = Date.now();
    logger.info(
      { guildId: this.guildId, voiceChannel: this.voiceChannel.id, sessionDir: this.sessionDir },
      'starting recording session',
    );

    const connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.voiceChannel.guild.id,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    this.connection = connection;

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    } catch (err) {
      connection.destroy();
      this.connection = null;
      throw new Error(
        `ボイスチャネルへの接続に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (!this.stopped) {
          logger.warn({ guildId: this.guildId }, 'voice connection lost; destroying');
          connection.destroy();
        }
      }
    });

    const receiver = connection.receiver;
    receiver.speaking.on('start', (userId: string) => {
      void this.handleSpeakingStart(userId);
    });
  }

  private async handleSpeakingStart(userId: string): Promise<void> {
    if (this.stopped) return;
    let recorder = this.recorders.get(userId);
    if (!recorder) {
      const member = await this.voiceChannel.guild.members.fetch(userId).catch(() => null);
      const username = member?.user.tag ?? userId;
      recorder = new SpeakerRecorder({
        userId,
        username,
        sessionDir: this.sessionDir!,
        receiver: this.connection!.receiver,
      });
      this.recorders.set(userId, recorder);
      logger.info({ userId, username }, 'new speaker registered');
    }
    recorder.beginUtterance();
  }

  /** 中間サマリを生成（録音は継続）。直列実行を保証する。 */
  snapshot(): Promise<void> {
    const next = this.mutex.then(() => this.snapshotInner());
    this.mutex = next.catch(() => undefined);
    return next;
  }

  private async snapshotInner(): Promise<void> {
    if (this.stopped) return;
    const recorders = [...this.recorders.values()];
    if (recorders.length === 0) {
      await this.textChannel.send('まだ発話が検出されていません。');
      return;
    }

    logger.info({ guildId: this.guildId, speakers: recorders.length }, 'snapshot rotation');
    const rotated = await Promise.all(
      recorders.map(async (r) => ({ username: r.username, path: await r.rotate() })),
    );

    const newTranscripts = await Promise.all(
      rotated.map(async ({ username, path: p }): Promise<SpeakerTranscript> => {
        try {
          const segments = await transcribeSpeaker({ audioPath: p, username });
          return { username, segments };
        } finally {
          await unlink(p).catch(() => undefined);
        }
      }),
    );

    const newMerged = mergeTranscripts(newTranscripts);
    this.accumulator.push(...newMerged);

    if (this.accumulator.length === 0) {
      await this.textChannel.send('文字起こしできる発話がまだありませんでした。');
      return;
    }

    const elapsedSec = (Date.now() - this.startedAt) / 1000;
    const minutes = await generateMinutes({
      merged: this.accumulator,
      durationSec: elapsedSec,
      interim: true,
    });

    await postMinutes(this.textChannel, `📌 **中間サマリ**\n\n${minutes}`);
  }

  /** 録音停止 → 残りのチャンクを文字起こし → 全体議事録生成 → 投稿 → クリーンアップ */
  stop(): Promise<void> {
    const next = this.mutex.then(() => this.stopInner());
    this.mutex = next.catch(() => undefined);
    return next;
  }

  private async stopInner(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const sessionDir = this.sessionDir;

    try {
      const durationSec = (Date.now() - this.startedAt) / 1000;
      const recorders = [...this.recorders.values()];
      logger.info(
        { guildId: this.guildId, speakers: recorders.length, durationSec },
        'stopping recording session',
      );

      const finalPaths = await Promise.all(
        recorders.map(async (r) => ({ username: r.username, path: await r.finalize() })),
      );

      if (this.connection) {
        try {
          this.connection.destroy();
        } catch {
          /* noop */
        }
        this.connection = null;
      }

      if (recorders.length === 0 && this.accumulator.length === 0) {
        await this.textChannel.send('発話が検出されなかったため、議事録は生成されませんでした。');
        return;
      }

      const finalTranscripts = await Promise.all(
        finalPaths.map(async ({ username, path: p }): Promise<SpeakerTranscript> => {
          try {
            const segments = await transcribeSpeaker({ audioPath: p, username });
            return { username, segments };
          } finally {
            await unlink(p).catch(() => undefined);
          }
        }),
      );

      const finalMerged = mergeTranscripts(finalTranscripts);
      const all: MergedSegment[] = [...this.accumulator, ...finalMerged];

      if (all.length === 0) {
        await this.textChannel.send('文字起こしに失敗、または音声が認識できませんでした。');
        return;
      }

      const minutes = await generateMinutes({ merged: all, durationSec });

      await postMinutes(this.textChannel, minutes);
    } finally {
      if (sessionDir) {
        await removeDir(sessionDir).catch((err) =>
          logger.error({ err, sessionDir }, 'cleanup failed'),
        );
      }
    }
  }
}
