import type { TranscriptSegment } from './transcribe.js';

export interface MergedSegment {
  startSec: number;
  endSec: number;
  speaker: string;
  text: string;
}

export interface SpeakerTranscript {
  username: string;
  segments: TranscriptSegment[];
}

/**
 * 各話者ごとの音声は無音区間が削除されたもの。
 * Gemini の startSec/endSec は「その話者の音声ファイル内のローカル秒」になるため、
 * 厳密にはセッション全体の絶対時刻にはマップできないが、十分実用的な近似として
 * - 話者ごとに startSec で整列
 * - 全話者をマージしてからは話者ごとの音声出現順を保ちつつ、startSec の昇順で並べる
 *
 * これは完全な時系列再現ではないが、議事録生成には十分な情報量。
 * （将来、SpeakerRecorder.utterances から発話開始オフセットを使った正確な再構成も可能）
 */
export function mergeTranscripts(perSpeaker: SpeakerTranscript[]): MergedSegment[] {
  const all: MergedSegment[] = [];
  for (const sp of perSpeaker) {
    for (const s of sp.segments) {
      all.push({
        startSec: s.startSec,
        endSec: s.endSec,
        speaker: sp.username,
        text: s.text,
      });
    }
  }
  all.sort((a, b) => a.startSec - b.startSec);
  return all;
}

/** 議事録生成用に、トランスクリプトを「話者: テキスト」形式の文字列に変換 */
export function formatTranscriptForLLM(merged: MergedSegment[]): string {
  return merged
    .map((s) => {
      const t = formatTime(s.startSec);
      return `[${t}] ${s.speaker}: ${s.text}`;
    })
    .join('\n');
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
