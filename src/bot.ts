import { rmSync } from 'node:fs';
import { AiUnavailable, type Ai } from './ai';
import { respond, respondToImage } from './assistant';
import { localDay, localHour } from './dates';
import { dueNotices } from './scheduler';
import type { Store } from './store';
import type { Telegram, Update } from './telegram';

const BACKUP_HOUR = 3;
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
    this.store.set('offset', String(u.update_id + 1));
    const msg = u.message;
    if (!msg || msg.from?.id !== this.ownerId || msg.chat.id !== this.ownerId) return;
    let reply: string;
    try {
      reply = await this.reply(msg, ms);
      this.store.set('dirty', '1');
    } catch (err) {
      console.error('Error al procesar un mensaje:', err instanceof Error ? err.message : 'desconocido');
      reply = 'Algo falló y puede que no se haya anotado. Revisa con: ultimos';
    }
    await this.tg.send(msg.chat.id, reply);
  }

  private async reply(msg: NonNullable<Update['message']>, ms: number): Promise<string> {
    const today = localDay(ms);
    if (msg.text) return respond(this.store, this.ai, msg.text, today, ms);
    if (msg.voice) return this.onVoice(msg.voice, today, ms);
    if (msg.photo?.length) return this.onPhoto(msg.photo, msg.caption ?? '', today, ms);
    return 'Eso no lo entiendo todavía. Mándame texto, un audio o una captura.';
  }

  private async onVoice(voice: { file_id: string; duration: number }, today: string, ms: number) {
    if (!this.ai?.canHear) return 'Para escuchar audios me falta activar la IA. Por ahora escríbelo: 25 almuerzo';
    if (voice.duration > MAX_VOICE_SECONDS) return 'Ese audio es muy largo. Mándame uno de menos de 2 minutos.';
    try {
      const text = await this.ai.transcribe(await this.tg.download(voice.file_id), this.store.ledger().cards.map((c) => c.aliases[0]!));
      if (!text) return 'No escuché nada en ese audio. ¿Me lo repites?';
      return `Escuché: "${text}"\n\n${await respond(this.store, this.ai, text, today, ms)}`;
    } catch (err) {
      if (!(err instanceof AiUnavailable)) throw err;
      return 'No pude escuchar el audio ahora y no anoté nada. Escríbelo: 25 almuerzo';
    }
  }

  private async onPhoto(sizes: { file_id: string; file_size?: number }[], caption: string, today: string, ms: number) {
    const photo = sizes[sizes.length - 1]!;
    if ((photo.file_size ?? 0) > MAX_PHOTO_BYTES) return 'Esa imagen pesa mucho. Mándame una captura más liviana.';
    const blob = await this.tg.download(photo.file_id);
    const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');
    return respondToImage(this.store, this.ai, { base64, mime: 'image/jpeg' }, caption, today, ms);
  }

  async tick(ms = Date.now()) {
    for (const n of dueNotices(this.store, ms)) {
      await this.tg.send(this.ownerId, n.text);
      this.store.set(n.flag, '1');
    }
    await this.backup(ms);
  }

  /** Copia diaria fuera del VPS: llega como archivo silencioso a tu chat, solo si hubo cambios. */
  private async backup(ms: number) {
    const day = localDay(ms);
    const flag = `backup:${day}`;
    if (localHour(ms) < BACKUP_HOUR || this.store.get(flag) || this.store.get('dirty') !== '1') return;
    rmSync(this.backupPath, { force: true });
    this.store.backupTo(this.backupPath);
    try {
      await this.tg.sendDocument(this.ownerId, this.backupPath, `suave-${day}.db`);
      this.store.set(flag, '1');
      this.store.set('dirty', '0');
    } finally {
      rmSync(this.backupPath, { force: true });
    }
  }
}
