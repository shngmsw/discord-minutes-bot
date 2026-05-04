import { stat } from 'node:fs/promises';
import { Type, createPartFromUri } from '@google/genai';
import { config } from '../config.js';
import { logger } from '../util/logger.js';
import { withRetry } from '../util/retry.js';
import { genai } from './gemini-client.js';

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

interface TranscribeArgs {
  audioPath: string;
  username: string;
}

const PROMPT = [
  'これは1名の発話のみが収録された音声です（無音区間は事前に取り除かれています）。',
  '日本語で逐語的に文字起こしし、自然な区切り（句点・話題の区切り・1〜10秒程度の無音）でセグメント化してください。',
  '各セグメントには音声内のローカルな startSec / endSec（秒）と text を含めてください。',
  'フィラー（えー、あの、など）は最小限残し、明確な聞き取り不能箇所は [...] と記してください。',
  '',
  '**重要な制約**:',
  '- 音声に明確に含まれている言葉だけを書き起こしてください。',
  '- 聞き取れない・無音・不明瞭な場合は、内容を推測せず segments を空配列 [] で返してください。',
  '- 音声に無い情報（会社名・人名・トピックなど）を絶対に補完・捏造しないでください。',
  '- 音声がほぼ無音／背景雑音のみ／意味のある言葉が含まれない場合も、必ず segments: [] を返してください。',
  '',
  'JSON 以外は出力しないでください。',
].join('\n');

const MIN_AUDIO_SIZE_BYTES = 4_000;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          startSec: { type: Type.NUMBER },
          endSec: { type: Type.NUMBER },
          text: { type: Type.STRING },
        },
        required: ['startSec', 'endSec', 'text'],
        propertyOrdering: ['startSec', 'endSec', 'text'],
      },
    },
  },
  required: ['segments'],
  propertyOrdering: ['segments'],
} as const;

export async function transcribeSpeaker(args: TranscribeArgs): Promise<TranscriptSegment[]> {
  const { audioPath, username } = args;
  let uploadedName: string | undefined;

  const fileStat = await stat(audioPath).catch(() => null);
  const fileSize = fileStat?.size ?? 0;
  logger.info({ username, audioPath, fileSize }, 'transcribe start');
  if (fileSize < MIN_AUDIO_SIZE_BYTES) {
    logger.warn(
      { username, fileSize, threshold: MIN_AUDIO_SIZE_BYTES },
      'audio too small, skipping transcription to avoid hallucination',
    );
    return [];
  }

  try {
    const uploaded = await withRetry(
      () => genai.files.upload({ file: audioPath, config: { mimeType: 'audio/ogg' } }),
      { label: 'gemini files.upload' },
    );
    uploadedName = uploaded.name ?? undefined;

    let file = uploaded;
    const start = Date.now();
    while (file.state === 'PROCESSING') {
      if (Date.now() - start > 120_000) {
        throw new Error('Gemini Files API processing timeout');
      }
      await new Promise((r) => setTimeout(r, 1500));
      const got = await withRetry(() => genai.files.get({ name: file.name! }), {
        label: 'gemini files.get',
      });
      file = got;
    }
    if (file.state === 'FAILED') {
      throw new Error('Gemini Files API processing failed');
    }

    const response = await withRetry(
      () =>
        genai.models.generateContent({
          model: config.TRANSCRIPTION_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                createPartFromUri(file.uri!, file.mimeType ?? 'audio/ogg'),
                { text: PROMPT },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema,
            temperature: 0.1,
          },
        }),
      { label: 'gemini transcribe', retries: 5 },
    );

    const text = response.text;
    if (!text) {
      logger.warn({ username }, 'Gemini returned empty transcription response');
      return [];
    }

    const parsed = JSON.parse(text) as { segments?: TranscriptSegment[] };
    const segments = (parsed.segments ?? [])
      .filter((s) => typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.text)
      .map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text.trim() }));
    logger.info(
      {
        username,
        fileSize,
        segmentCount: segments.length,
        firstText: segments[0]?.text?.slice(0, 80),
      },
      'transcribe done',
    );
    return segments;
  } finally {
    if (uploadedName) {
      genai.files
        .delete({ name: uploadedName })
        .catch((err) => logger.warn({ err, uploadedName }, 'Files API delete failed'));
    }
  }
}
