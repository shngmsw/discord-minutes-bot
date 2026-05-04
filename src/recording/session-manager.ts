import { RecordingSession, type RecordingSessionInit } from './recording-session.js';
import { logger } from '../util/logger.js';

class SessionManager {
  private sessions = new Map<string, RecordingSession>();

  has(guildId: string): boolean {
    return this.sessions.has(guildId);
  }

  async start(init: RecordingSessionInit): Promise<void> {
    if (this.sessions.has(init.guildId)) {
      throw new Error('既に録音中です');
    }
    const session = new RecordingSession(init);
    this.sessions.set(init.guildId, session);
    try {
      await session.start();
    } catch (err) {
      this.sessions.delete(init.guildId);
      throw err;
    }
  }

  async stop(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) return;
    this.sessions.delete(guildId);
    await session.stop();
  }

  async snapshot(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) throw new Error('録音セッションが見つかりません');
    await session.snapshot();
  }

  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(
      ids.map((id) =>
        this.stop(id).catch((err) => logger.error({ err, guildId: id }, 'stop failed')),
      ),
    );
  }
}

export const sessionManager = new SessionManager();
