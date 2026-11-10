// Decide si un mensaje se resuelve con comandos o necesita IA, y mantiene las aclaraciones pendientes.
import { AiUnavailable, toCommand, type Ai, type Image } from './ai';
import { WEEKDAYS, type Day } from './dates';
import { aliasesOf, execute, handle } from './handlers';
import { normalize, parse, type Command } from './parser';
import type { Store } from './store';

const PENDING_MS = 10 * 60_000;
const MAX_PLAIN_WORDS = 5;
const DATE_WORDS = new RegExp(`\\b(ayer|anteayer|antier|hace|${WEEKDAYS.join('|')})\\b`);

const NOT_UNDERSTOOD = 'No te entendí, y no anoté nada. Cuéntamelo de otra forma, por ejemplo: gasté 25 en almuerzo.';
const AI_DOWN = 'Ahora no puedo interpretar mensajes libres y no anoté nada. Mientras tanto usa: 25 almuerzo';

/** '25 almuerzo' y 'almuerzo 25' no necesitan IA. Una frase o una fecha sí. */
export function looksNatural(text: string): boolean {
  const t = normalize(text);
  if (DATE_WORDS.test(t) || t.split(' ').length > MAX_PLAIN_WORDS) return true;
  return !(/^(s\/\.?\s*)?\d/.test(t) || /^\S+ [\d.,]+$/.test(t));
}

interface Pending { text: string; question: string; at: number }

function takePending(store: Store, ms: number): Pending | null {
  const raw = store.get('pending');
  if (!raw) return null;
  store.set('pending', '');
  const p = JSON.parse(raw) as Pending;
  return ms - p.at <= PENDING_MS ? p : null;
}

const context = (store: Store, today: Day) => {
  const l = store.ledger();
  const cards = [...aliasesOf(l).keys()].join(', ') || 'ninguna';
  const incomes = l.incomes.map((i) => i.name).join(', ') || 'ninguno';
  return `Hoy: ${today}, ${WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()]}.\nTarjetas: ${cards}.\nIngresos conocidos: ${incomes}.`;
};

async function interpret(store: Store, ai: Ai, prompt: string, today: Day, ms: number, image?: Image) {
  const reading = await ai.read({ text: `${context(store, today)}\n\nMensaje:\n${prompt}`, image });
  const cmd = toCommand(reading, aliasesOf(store.ledger()), today, Boolean(image));
  if (cmd.type === 'clarify') {
    store.set('pending', JSON.stringify({ text: prompt, question: cmd.question, at: ms }));
    return cmd.question;
  }
  return cmd.type === 'unknown' ? NOT_UNDERSTOOD : execute(store, cmd, today);
}

export async function respond(store: Store, ai: Ai | null, text: string, today: Day, ms: number): Promise<string> {
  if (!ai || store.get('step') !== 'done') return handle(store, text, today);

  const cmd: Command = parse(text, aliasesOf(store.ledger()));
  const pending = takePending(store, ms);
  const natural = cmd.type === 'unknown' || (cmd.type === 'expense' && looksNatural(text));
  if (!pending && !natural) return execute(store, cmd, today);

  const prompt = pending
    ? `Mensaje anterior: ${pending.text}\nLe preguntaste: ${pending.question}\nRespondió: ${text}`
    : text;
  try {
    return await interpret(store, ai, prompt, today, ms);
  } catch (err) {
    if (!(err instanceof AiUnavailable)) throw err;
    if (cmd.type === 'unknown') return AI_DOWN;
    return `${execute(store, cmd, today)}\n\n(Sin IA por ahora: lo anoté con fecha de hoy. Si no es así, escribe deshacer.)`;
  }
}

export async function respondToImage(store: Store, ai: Ai | null, image: Image, caption: string, today: Day, ms: number) {
  if (store.get('step') !== 'done') return 'Primero terminemos de configurarte.';
  if (!ai) return 'Para leer capturas me falta activar la IA. Por ahora anótalo así: 25 almuerzo';
  const note = caption ? `\nNota del usuario: ${caption}` : '';
  try {
    return await interpret(store, ai, `Interpreta esta captura.${note}`, today, ms, image);
  } catch (err) {
    if (!(err instanceof AiUnavailable)) throw err;
    return 'No pude leer la captura ahora y no anoté nada. Anótalo así: 25 almuerzo';
  }
}
