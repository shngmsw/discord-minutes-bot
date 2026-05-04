import { AttachmentBuilder } from 'discord.js';
import type { GuildBasedChannel, TextBasedChannel } from 'discord.js';

const DISCORD_LIMIT = 2000;
const HARD_FALLBACK_AT = 5; // 5メッセージを超える分割なら添付に切り替え

export async function postMinutes(
  channel: GuildBasedChannel & TextBasedChannel,
  markdown: string,
): Promise<void> {
  const chunks = splitForDiscord(markdown);

  if (chunks.length > HARD_FALLBACK_AT) {
    const buf = Buffer.from(markdown, 'utf-8');
    const file = new AttachmentBuilder(buf, { name: 'minutes.md' });
    if ('send' in channel) {
      await channel.send({ content: '📋 議事録（添付）', files: [file] });
    }
    return;
  }

  if (!('send' in channel)) return;
  for (const c of chunks) {
    await channel.send({ content: c });
  }
}

/** Markdown を 2000 字以内のチャンクに分割。コードブロックや箇条書きを跨ぐとき安全側で改行で切る。 */
function splitForDiscord(text: string): string[] {
  if (text.length <= DISCORD_LIMIT) return [text];

  const result: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (line.length > DISCORD_LIMIT) {
      // 1行が長すぎる場合は強制分割
      if (buf) {
        result.push(buf);
        buf = '';
      }
      for (let i = 0; i < line.length; i += DISCORD_LIMIT) {
        result.push(line.slice(i, i + DISCORD_LIMIT));
      }
      continue;
    }
    if (buf.length + line.length + 1 > DISCORD_LIMIT) {
      result.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) result.push(buf);
  return result;
}
