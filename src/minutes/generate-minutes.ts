import { config } from '../config.js';
import { genai } from '../transcription/gemini-client.js';
import {
  formatTranscriptForLLM,
  type MergedSegment,
} from '../transcription/merge-transcripts.js';
import { withRetry } from '../util/retry.js';

interface GenerateMinutesArgs {
  merged: MergedSegment[];
  durationSec: number;
  interim?: boolean;
}

const SYSTEM_FINAL = [
  'あなたは日本語の会議議事録作成アシスタントです。',
  '与えられる発話ログから、読みやすい Markdown 形式の議事録を作成してください。',
  '次の見出しを必ず含め、該当がない項目は「特になし」と書いてください。',
  '## 概要 / ## 主要な議題 / ## 決定事項 / ## ToDo / ## 次回への持ち越し',
  '発言の引用は最小限に留め、要点を整理してください。固有名詞や数字は正確に保持してください。',
  '',
  '**最重要の制約**: 発話ログに無い情報を絶対に補完・捏造しないでください。',
  '社名・人名・専門用語など、ログに登場していない固有名詞を使ってはいけません。',
  '曖昧な部分や聞き取り不能箇所は「（未確定）」と記してください。',
  '発話ログが極端に短い・内容が薄い場合は、無理に内容を膨らませず短い議事録にしてください。',
].join('\n');

const SYSTEM_INTERIM = [
  'あなたは日本語の会議の中間サマリ作成アシスタントです。',
  '会議は **進行中** です。これまでの発話ログから、現時点までの議論を整理してください。',
  '次の見出しを必ず含めてください。該当がない項目は「特になし」と書いてください。',
  '## ここまでの議論の要旨',
  '## 出てきている論点',
  '## 暫定で決まりかけていること',
  '## 未解決・要確認',
  '## アクション候補（誰が・何を・いつまで）',
  '会議は継続中なので、確定的な「決定事項」「ToDo」とは書かず、「暫定」「候補」と表記してください。',
  '聞き取り不能箇所や曖昧な部分は「（未確定）」と記してください。',
  '',
  '**最重要の制約**: 発話ログに無い情報を絶対に補完・捏造しないでください。',
  '発話ログが極端に短い・内容が薄い・断片的な場合は、無理に内容を膨らませず「現時点で実質的な議論はまだ確認できません」とだけ書いてください。',
  '社名・人名・専門用語など、ログに登場していない固有名詞を使ってはいけません。',
].join('\n');

export async function generateMinutes(args: GenerateMinutesArgs): Promise<string> {
  const transcript = formatTranscriptForLLM(args.merged);
  const speakers = [...new Set(args.merged.map((s) => s.speaker))];
  const durationLabel = `${Math.round(args.durationSec / 60)} 分`;
  const speakerList = speakers.join(', ');
  const isInterim = args.interim === true;

  const userPrompt = [
    `# 録音情報`,
    `- ${isInterim ? '経過時間' : '録音時間'}: ${durationLabel}（約 ${Math.round(args.durationSec)} 秒）`,
    `- 参加者: ${speakerList}`,
    ``,
    `# 発話ログ（[mm:ss] 話者: 内容、時刻はチャンク内のおおよその目安）`,
    transcript,
    ``,
    isInterim ? `上記から中間サマリを作成してください。` : `上記から議事録を作成してください。`,
  ].join('\n');

  const response = await withRetry(
    () =>
      genai.models.generateContent({
        model: config.MINUTES_MODEL,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: isInterim ? SYSTEM_INTERIM : SYSTEM_FINAL,
          temperature: 0.3,
        },
      }),
    { label: 'gemini minutes', retries: 5 },
  );

  return response.text?.trim() ?? '議事録の生成に失敗しました。';
}
