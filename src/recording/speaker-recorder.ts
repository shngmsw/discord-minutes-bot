import path from 'node:path';
import { EndBehaviorType, type VoiceReceiver } from '@discordjs/voice';
import prism from 'prism-media';
import { SpeakerFfmpeg } from './ffmpeg-encoder.js';
import { logger } from '../util/logger.js';

/**
 * 1ユーザー分の録音を担当するクラス。
 * - 話者別に1本の OGG/Opus ファイルを生成
 * - 発話ごとに receiver.subscribe を行い、Opus → PCM → ffmpeg stdin へ流す
 * - 無音区間中は stdin に何も流さないので、ファイルに無音は含まれない
 * - rotate() を呼ぶと現行 ffmpeg を flush し、新しいファイルで録音継続できる
 */
export class SpeakerRecorder {
  readonly userId: string;
  readonly username: string;
  private currentPath: string;
  private segmentIndex = 0;
  private readonly sessionDir: string;
  private ffmpeg: SpeakerFfmpeg;
  private receiver: VoiceReceiver;
  private activeUtterance: { startedAtMs: number } | null = null;
  private activeStream: NodeJS.ReadableStream | null = null;
  private rotating = false;

  constructor(args: {
    userId: string;
    username: string;
    sessionDir: string;
    receiver: VoiceReceiver;
  }) {
    this.userId = args.userId;
    this.username = args.username;
    this.sessionDir = args.sessionDir;
    this.receiver = args.receiver;
    this.currentPath = path.join(this.sessionDir, `${this.userId}-0.ogg`);
    this.ffmpeg = new SpeakerFfmpeg(this.currentPath);
  }

  get oggPath(): string {
    return this.currentPath;
  }

  /** speaking.start イベントから呼ばれる。 */
  beginUtterance(): void {
    if (this.rotating) return;
    if (this.activeUtterance) return;

    this.activeUtterance = { startedAtMs: Date.now() };

    const opusStream = this.receiver.subscribe(this.userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    const pcm = opusStream.pipe(decoder);
    this.activeStream = pcm;

    pcm.on('data', (chunk: Buffer) => {
      this.ffmpeg.writePcm(chunk);
    });

    const onEnd = (): void => {
      this.activeUtterance = null;
      this.activeStream = null;
      try {
        decoder.destroy();
      } catch {
        /* noop */
      }
    };

    pcm.once('end', onEnd);
    pcm.once('close', onEnd);
    pcm.once('error', (err) => {
      logger.warn({ err, userId: this.userId }, 'pcm stream error');
      onEnd();
    });
  }

  /**
   * 現行の OGG ファイルを flush し、新しいファイルで録音を継続する。
   * 戻り値: 直前まで書き込んでいた完了済みファイルのパス。
   */
  async rotate(): Promise<string> {
    this.rotating = true;
    try {
      if (this.activeStream) {
        try {
          (this.activeStream as { destroy?: () => void }).destroy?.();
        } catch {
          /* noop */
        }
        this.activeStream = null;
        this.activeUtterance = null;
      }

      const completedPath = this.currentPath;
      await this.ffmpeg.close().catch((err) => {
        logger.error({ err, userId: this.userId }, 'ffmpeg close failed during rotate');
      });

      this.segmentIndex += 1;
      this.currentPath = path.join(this.sessionDir, `${this.userId}-${this.segmentIndex}.ogg`);
      this.ffmpeg = new SpeakerFfmpeg(this.currentPath);
      return completedPath;
    } finally {
      this.rotating = false;
    }
  }

  async finalize(): Promise<string> {
    this.rotating = true;
    if (this.activeStream) {
      try {
        (this.activeStream as { destroy?: () => void }).destroy?.();
      } catch {
        /* noop */
      }
      this.activeStream = null;
      this.activeUtterance = null;
    }
    await this.ffmpeg.close().catch((err) => {
      logger.error({ err, userId: this.userId }, 'ffmpeg close failed');
    });
    return this.currentPath;
  }

  abort(): void {
    this.ffmpeg.kill();
  }
}
