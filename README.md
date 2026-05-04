# discord-minutes-bot

Craig 風の Discord 録音 Bot。ボイスチャネルでの会話を **話者別に録音** し、Gemini API で **文字起こし & 議事録生成** を行います。録音ファイル自体は文字起こし完了後に自動削除し、議事録のみがコマンドを実行したテキストチャネルに投稿されます。

## 構成

- Node.js 20+ / TypeScript
- `discord.js` v14 + `@discordjs/voice`（Opus デコードは純 JS の `opusscript`、暗号化は `libsodium-wrappers`）
- `prism-media` → `ffmpeg`（spawn）で OGG/Opus へエンコード
- 文字起こし: Gemini `gemini-2.5-pro` (Files API + structured JSON)
- 議事録生成: Gemini `gemini-2.5-flash`

## 必要なもの

### システム

```sh
sudo apt install -y ffmpeg
```

> ネイティブビルドツール（`build-essential`, `python3` 等）は **不要** です。`@discordjs/opus` / `sodium-native` を入れたい場合（性能改善目的）は別途必要になります。

### Discord Bot 側

1. <https://discord.com/developers/applications> で Bot を作成
2. Bot に **以下の Intent / Permission を付与**
   - Privileged Gateway Intents: `Server Members` は不要、`Voice States` は Discord 側で自動付与（`GuildVoiceStates`）
   - OAuth2 → URL Generator → scopes: `bot`, `applications.commands`
   - Bot Permissions: `View Channels`, `Send Messages`, `Connect`, `Speak`, `Use Voice Activity`, `Attach Files`
3. 生成された URL からテストサーバーに招待

### Gemini API キー

<https://aistudio.google.com/apikey> から発行。

## セットアップ

```sh
cp .env.example .env
# .env を編集して各値を設定

npm install
npm run deploy:guild   # テストサーバーに /record を即時登録
npm run dev            # 起動（tsx watch）
```

`.env` 必須項目:

| キー | 内容 |
| --- | --- |
| `DISCORD_TOKEN` | Bot トークン |
| `DISCORD_CLIENT_ID` | Application ID |
| `DISCORD_GUILD_ID` | 開発用テストサーバー ID（global 配信したいときは未設定で `npm run deploy:global`） |
| `GEMINI_API_KEY` | Gemini API キー |
| `TRANSCRIPTION_MODEL` | デフォルト `gemini-2.5-pro` |
| `MINUTES_MODEL` | デフォルト `gemini-2.5-flash` |
| `TMP_ROOT` | 録音中の一時ファイル置き場（デフォルト `/tmp/discord-minutes`） |
| `LOG_LEVEL` | `info` / `debug` 等 |

## 使い方

1. 録音したいボイスチャネルに参加する
2. テキストチャネルで `/record start` を実行 → Bot が VC に入って録音開始
3. 会話する
4. `/record stop` を実行 → Bot が退出し、文字起こし & 議事録生成 → そのテキストチャネルに投稿

議事録が 2000 文字を超える場合は自動でメッセージ分割し、それでも収まらなければ `minutes.md` として添付します。

## 動作の流れ

```
/record start
  └─ joinVoiceChannel → receiver.speaking.on('start', userId)
       └─ 各ユーザーごとに 1 本の OGG/Opus を ffmpeg で生成
            （無音区間はファイルに含まれない）

/record stop
  ├─ receiver 解除 → ffmpeg flush
  ├─ 各話者の OGG を Gemini Files API へ upload
  ├─ gemini-2.5-pro で構造化 JSON 文字起こし (segments + timestamps)
  ├─ 全話者をマージ（startSec で時系列ソート）
  ├─ gemini-2.5-flash で議事録 Markdown を生成
  ├─ チャネルに投稿
  └─ tmp 削除 / Files API delete
```

## 制限と注意点

- 各話者の音声は **無音区間が事前に削除された状態** で Gemini に渡されるため、議事録のタイムライン精度はあくまで近似です（厳密な時刻は再構成不可）。
- Gemini Files API のファイル上限は 20MB / 9.5 時間。長時間会議は分割が必要です。
- 録音ファイル（OGG）は議事録生成後に **必ず削除** されます。途中でクラッシュした場合は `$TMP_ROOT` に残るので手動で削除してください。
- Discord 仕様上、Bot は **音声を完璧には受信できないことがあります**（DAVE E2EE、ネットワーク状態などの影響）。

## 常駐化（WSL2）

`systemd --user` で運用します。

```sh
mkdir -p ~/.config/systemd/user/
cp scripts/discord-minutes-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now discord-minutes-bot.service

# WSL2 起動時に自動起動させる
sudo loginctl enable-linger $USER

# 状態確認
systemctl --user status discord-minutes-bot.service
journalctl --user -u discord-minutes-bot.service -f
```

## トラブルシュート

- **`ffmpeg: not found`**: `sudo apt install ffmpeg`
- **Bot が VC に入るが音が拾えない**: Bot の `selfDeaf: false` が必須（本実装では設定済）。VC の権限で `Use Voice Activity` を確認。
- **`/record` コマンドが見つからない**: `npm run deploy:guild` を再実行。global 配信は反映に最大 1 時間。
- **Gemini が空のレスポンス**: 音声が極端に短い／無音率が高い／API レート制限。`LOG_LEVEL=debug` で詳細を確認。

## ファイル構成

```
src/
├── index.ts                          # Client起動、ルーティング
├── config.ts                         # zodで env 型付け
├── deploy-commands.ts                # slash command 登録
├── commands/
│   ├── index.ts
│   └── record.ts                     # /record start, /record stop
├── recording/
│   ├── session-manager.ts            # guildId 単位の Session Map
│   ├── recording-session.ts          # VC join、receiver 購読、停止時の全パイプライン
│   ├── speaker-recorder.ts           # 1ユーザー = 1 OGG ファイル
│   └── ffmpeg-encoder.ts             # ffmpeg spawn ラッパ
├── transcription/
│   ├── gemini-client.ts              # @google/genai 初期化
│   ├── transcribe.ts                 # 1 ファイルを Files API + structured JSON
│   └── merge-transcripts.ts          # 全話者を時系列マージ
├── minutes/
│   └── generate-minutes.ts           # 議事録 Markdown 生成
├── discord/
│   └── post-minutes.ts               # 2000字分割 / .md 添付フォールバック
└── util/
    ├── logger.ts                     # pino
    └── tempdir.ts                    # session毎 tmp dir 管理
```
