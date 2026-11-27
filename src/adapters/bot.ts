// Puente entre Telegram y la app: filtra al dueño, baja audios y fotos, y dispara avisos y backups.
import { backupIfDue } from '../app/backup';
import { dueNotices } from '../app/notices';
import { localDay } from '../domain/dates';
import { AiUnavailable, type Ai } from '../input/ai';
import { respond, respondToImage } from '../input/router';
import { fallback } from '../replies/es';
import type { Store } from './store';
import type { Telegram, Update } from './telegram';

const MAX_VOICE_SECONDS = 120;
const MAX_PHOTO_BYTES = 10_000_000;

export class Bot {
  constructor(
    private readonly store: Store,
    private readonly tg: Telegram,
    private readonly ownerId: number,
    private readonly backupPath: string,
    private readonly ai: Ai | null = null,
  ) {}

  /** Solo se atiende al dueño; cualquier otro mensaje se ignora en silencio. */
  async onUpdate(u: Update, ms = Date.now()) {
    this.store.offset = u.update_id + 1;
    const msg = u.message;
    if (!msg || msg.from?.id !== this.ownerId || msg.chat.id !== this.ownerId) return;
    let reply: string;
    try {
      reply = await this.reply(msg, ms);
      this.store.dirty = true;
    } catch (err) {
      console.error('Error al procesar un mensaje:', err instanceof Error ? err.message : 'desconocido');
      reply = fallback.crashed;
    }
    await this.tg.send(msg.chat.id, reply);
  }

  private async reply(msg: NonNullable<Update['message']>, ms: number): Promise<string> {
    const today = localDay(ms);
    if (msg.text) return respond(this.store, this.ai, msg.text, today, ms);
    if (msg.voice) return this.onVoice(msg.voice, today, ms);
    if (msg.photo?.length) return this.onPhoto(msg.photo, msg.caption ?? '', today, ms);
    return fallback.unsupported;
  }

  private async onVoice(voice: { file_id: string; duration: number }, today: string, ms: number) {
    if (!this.ai?.canHear) return fallback.voiceNoAi;
    if (voice.duration > MAX_VOICE_SECONDS) return fallback.voiceTooLong;
    try {
      const cards = this.store.ledger().cards.map((c) => c.aliases[0]!);
      const text = await this.ai.transcribe(await this.tg.download(voice.file_id), cards);
      if (!text) return fallback.voiceEmpty;
      return fallback.heard(text, await respond(this.store, this.ai, text, today, ms));
    } catch (err) {
      if (!(err instanceof AiUnavailable)) throw err;
      return fallback.voiceFailed;
    }
  }

  private async onPhoto(sizes: { file_id: string; file_size?: number }[], caption: string, today: string, ms: number) {
    const photo = sizes[sizes.length - 1]!;
    if ((photo.file_size ?? 0) > MAX_PHOTO_BYTES) return fallback.photoTooBig;
    const blob = await this.tg.download(photo.file_id);
    const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    return respondToImage(this.store, this.ai, { base64, mime: 'image/jpeg' }, caption, today, ms);
  }

  async tick(ms = Date.now()) {
    for (const n of dueNotices(this.store, ms)) {
      await this.tg.send(this.ownerId, n.text);
      this.store.setFlag(n.flag);
    }
    await backupIfDue(this.store, this.backupPath, (path, name) => this.tg.sendDocument(this.ownerId, path, name), ms);
  }
}
