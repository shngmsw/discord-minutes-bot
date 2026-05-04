import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().optional(),
  GEMINI_API_KEY: z.string().min(1),
  TRANSCRIPTION_MODEL: z.string().default('gemini-2.5-pro'),
  MINUTES_MODEL: z.string().default('gemini-2.5-flash'),
  TMP_ROOT: z.string().default('/tmp/discord-minutes'),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
