import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { logger } from '../util/logger.js';

const FFMPEG_BIN = ffmpegPath ?? 'ffmpeg';

/**
 * 1発話分の PCM (s16le 48kHz stereo) を OGG/Opus に変換し、指定ファイルに append する。
 * spawn で都度 ffmpeg を起動するので、1ファイルに append でつなげる際は OGG を結合できないことに注意。
 * → 各発話を個別の `<userId>-<index>.ogg` として保存し、文字起こし時にまとめて扱う方が安全。
 *   ただし発話数が多いと Files API への upload 数が爆発するので、ここでは「話者別1ファイル」を維持する。
 *   そのため、stdin が close されない長寿命 ffmpeg を1話者あたり1本維持する。
 */
export class SpeakerFfmpeg {
  private proc: ChildProcessWithoutNullStreams;
  private done: Promise<void>;

  constructor(outPath: string) {
    this.proc = spawn(
      FFMPEG_BIN,
      [
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-i',
        'pipe:0',
        '-c:a',
        'libopus',
        '-b:a',
        '64k',
        '-application',
        'voip',
        '-f',
        'ogg',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    this.proc.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf-8').trim();
      if (msg) logger.debug({ msg }, 'ffmpeg stderr');
    });

    const out = createWriteStream(outPath);
    this.proc.stdout.pipe(out);

    this.done = new Promise<void>((resolve, reject) => {
      let exited = false;
      this.proc.on('error', (err) => reject(err));
      this.proc.on('exit', (code) => {
        exited = true;
        if (code === 0 || code === null) resolve();
        else reject(new Error(`ffmpeg exited with code ${code}`));
      });
      out.on('error', (err) => {
        if (!exited) this.proc.kill('SIGKILL');
        reject(err);
      });
      out.on('close', () => {
        if (exited) resolve();
      });
    });
  }

  /** PCM チャンクを ffmpeg stdin に書き込み。完了時に close を呼び出す必要がある。 */
  writePcm(chunk: Buffer): void {
    if (!this.proc.stdin.writable) return;
    this.proc.stdin.write(chunk);
  }

  pipePcm(stream: Readable): void {
    stream.on('data', (chunk: Buffer) => this.writePcm(chunk));
  }

  /** stdin を閉じて ffmpeg のフラッシュ・終了を待つ。 */
  async close(): Promise<void> {
    if (this.proc.stdin.writable) this.proc.stdin.end();
    await this.done;
  }

  /** 異常終了用。データはフラッシュされない。 */
  kill(): void {
    if (!this.proc.killed) this.proc.kill('SIGKILL');
  }
}
