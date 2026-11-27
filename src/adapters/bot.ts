// Puente entre Telegram y la app: controla el acceso, atiende a cada usuario con su propia base,
// baja audios y fotos, y dispara avisos, backups y el tipo de cambio.
import { createHash } from 'node:crypto';
import { backupIfDue } from '../app/backup';
import { refreshRate, type RateSource } from '../app/fx';
import { dueNotices } from '../app/notices';
import { localDay } from '../domain/dates';
import { normalize } from '../domain/normalize';
import { AiUnavailable, type Ai } from '../input/ai';
import { respond, respondToImage } from '../input/router';
import { access as say, fallback } from '../replies/es';
import type { Access } from './access';
import type { Store } from './store';
import type { Telegram, Update, User } from './telegram';

const MAX_VOICE_SECONDS = 120;
const MAX_PHOTO_BYTES = 10_000_000;
const MAX_PENDING = 20; // más solicitudes sin responder que esto se ignoran: evita que te llenen de avisos
const FX_RETRY_MS = 60 * 60_000; // si la API de tipo de cambio falla, reintenta cada hora
const noRate: RateSource = async () => null;

type Message = NonNullable<Update['message']>;
type Decision = 'approve' | 'deny' | 'revoke';

const displayName = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || `ID ${u.id}`;

export class Bot {
  private lastFxAttempt = -Infinity;

  constructor(
    private readonly tg: Telegram,
    private readonly access: Access,
    private readonly ai: Ai | null = null,
    private readonly rateSource: RateSource = noRate,
  ) {}

  async onUpdate(u: Update, ms = Date.now()) {
    this.access.offset = u.update_id + 1;
    if (u.callback_query) return this.onButton(u.callback_query, ms);

    const msg = u.message;
    // Solo chats privados: en un grupo, el chat no es de quien escribe.
    if (!msg?.from || msg.chat.id !== msg.from.id) return;
    const id = msg.from.id;
    if (!this.access.canUse(id)) return this.onStranger(msg.from, ms);

    const store = this.access.storeFor(id);
    let reply: string;
    try {
      const admin = this.access.isOwner(id) && msg.text ? await this.ownerCommand(msg.text, ms) : null;
      reply = admin ?? (await this.reply(store, msg, ms));
      store.dirty = true;
    } catch (err) {
      console.error('Error al procesar un mensaje:', err instanceof Error ? err.message : 'desconocido');
      reply = fallback.crashed;
    }
    await this.tg.send(id, reply);
  }

  /** Alguien sin acceso: la primera vez se pide al dueño; después solo se le recuerda que espere. */
  private async onStranger(from: User, ms: number) {
    const member = this.access.member(from.id);
    if (member?.status === 'pending') return this.tg.send(from.id, say.stillPending);
    if (member) return; // rechazado o sin acceso: silencio, para no avisarte de nuevo
    if (this.access.members('pending').length >= MAX_PENDING) return;

    this.access.request(from.id, displayName(from), from.username ?? '', ms);
    await this.tg.send(from.id, say.requested);
    await this.tg.send(this.access.ownerId, say.ownerRequest(displayName(from), from.username ?? '', from.id), [
      [say.approveButton, `access:approve:${from.id}`],
      [say.denyButton, `access:deny:${from.id}`],
    ]);
  }

  private async onButton(q: NonNullable<Update['callback_query']>, ms: number) {
    const m = q.data?.match(/^access:(approve|deny):(\d+)$/);
    if (!m) return this.tg.answerCallback(q.id);
    if (!this.access.isOwner(q.from.id)) return this.tg.answerCallback(q.id, say.onlyOwner);

    const target = Number(m[2]);
    if (this.access.member(target)?.status !== 'pending') return this.tg.answerCallback(q.id, say.alreadyDecided);
    const text = await this.decide(target, m[1] as Decision, ms);
    await this.tg.answerCallback(q.id);
    if (q.message) await this.tg.edit(q.message.chat.id, q.message.message_id, text);
  }

  /** Aprueba, rechaza o quita el acceso, y le avisa a la persona. Devuelve el texto para el dueño. */
  private async decide(id: number, decision: Decision, ms: number): Promise<string> {
    const member = this.access.member(id);
    if (!member) return say.notFound(id);
    if (decision === 'approve') {
      const returning = member.status === 'revoked' || member.status === 'denied';
      this.access.decide(id, 'approved', ms);
      const store = this.access.storeFor(id);
      if (!store.step) await this.tg.send(id, say.welcome(await respond(store, this.ai, '/start', localDay(ms), ms)));
      return returning ? say.restored(member.name) : say.approved(member.name);
    }
    if (decision === 'deny') {
      this.access.decide(id, 'denied', ms);
      if (member.status === 'pending') await this.tg.send(id, say.rejected);
      return say.denied(member.name);
    }
    this.access.decide(id, 'revoked', ms);
    return say.revoked(member.name);
  }

  /** Comandos que solo el dueño puede usar. Devuelve null si el texto no es uno de ellos. */
  private async ownerCommand(text: string, ms: number): Promise<string | null> {
    const t = normalize(text);
    if (t === 'usuarios' || t === '/usuarios') return say.list(this.access.members());
    const m = t.match(/^\/?(aprobar|rechazar|quitar) (\d+)$/);
    if (!m) return null;
    const decision: Record<string, Decision> = { aprobar: 'approve', rechazar: 'deny', quitar: 'revoke' };
    return this.decide(Number(m[2]), decision[m[1]!]!, ms);
  }

  private async reply(store: Store, msg: Message, ms: number): Promise<string> {
    const today = localDay(ms);
    if (msg.text) return respond(store, this.ai, msg.text, today, ms);
    if (msg.voice) return this.onVoice(store, msg.voice, today, ms);
    if (msg.photo?.length) return this.onPhoto(store, msg.photo, msg.caption ?? '', today, ms);
    return fallback.unsupported;
  }

  private async onVoice(store: Store, voice: { file_id: string; duration: number }, today: string, ms: number) {
    if (!this.ai?.canHear) return fallback.voiceNoAi;
    if (voice.duration > MAX_VOICE_SECONDS) return fallback.voiceTooLong;
    try {
      const cards = store.ledger().cards.map((c) => c.aliases[0]!);
      const text = await this.ai.transcribe(await this.tg.download(voice.file_id), cards);
      if (!text) return fallback.voiceEmpty;
      return fallback.heard(text, await respond(store, this.ai, text, today, ms));
    } catch (err) {
      if (!(err instanceof AiUnavailable)) throw err;
      return fallback.voiceFailed;
    }
  }

  private async onPhoto(store: Store, sizes: { file_id: string; file_size?: number }[], caption: string, today: string, ms: number) {
    const photo = sizes[sizes.length - 1]!;
    if ((photo.file_size ?? 0) > MAX_PHOTO_BYTES) return fallback.photoTooBig;
    const bytes = Buffer.from(await (await this.tg.download(photo.file_id)).arrayBuffer());
    // La misma imagen (reenviada o mandada dos veces) tiene los mismos bytes: no se anota dos veces.
    const flag = `photo:${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}` as const;
    if (store.hasFlag(flag)) return fallback.photoDuplicate;
    const before = store.lastTxnId();
    const reply = await respondToImage(store, this.ai, { base64: bytes.toString('base64'), mime: 'image/jpeg' }, caption, today, ms);
    if (store.lastTxnId() !== before) store.setFlag(flag);
    return reply;
  }

  /** Cada minuto: tipo de cambio, avisos y backup de cada usuario, cada uno a su propio chat. */
  async tick(ms = Date.now()) {
    const ids = this.access.activeIds();
    const stores = ids.map((id) => this.access.storeFor(id));
    if (ms - this.lastFxAttempt >= FX_RETRY_MS && stores.some((s) => s.usdRateDay !== localDay(ms))) {
      this.lastFxAttempt = ms;
      await refreshRate(stores, this.rateSource, ms);
    }
    for (const [i, id] of ids.entries()) {
      const store = stores[i]!;
      try {
        for (const n of dueNotices(store, ms)) {
          await this.tg.send(id, n.text);
          store.setFlag(n.flag);
        }
        await backupIfDue(store, this.access.backupPathFor(id), (path, name) => this.tg.sendDocument(id, path, name), ms);
      } catch (err) {
        // Un usuario que bloqueó el bot no debe frenar los avisos de los demás.
        console.error(`Avisos de ${id}:`, err instanceof Error ? err.message : 'error');
      }
    }
  }
}
