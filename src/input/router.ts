// Decide si un mensaje se resuelve con atajos o necesita IA, y mantiene las aclaraciones pendientes.
import type { Store } from '../adapters/store';
import { execute } from '../app/execute';
import { onboard, startOnboarding } from '../app/onboarding';
import type { Command } from '../domain/command';
import { WEEKDAYS, type Day } from '../domain/dates';
import { aliasesOf } from '../domain/ledger';
import { normalize } from '../domain/normalize';
import { fallback, onboarding } from '../replies/es';
import { AiUnavailable, toCommand, type Ai, type Image } from './ai';
import { parse } from './shortcuts';

const PENDING_MS = 10 * 60_000;
const MAX_PLAIN_WORDS = 5;
const DATE_WORDS = new RegExp(`\\b(ayer|anteayer|antier|hace|${WEEKDAYS.join('|')})\\b`);

/** '25 almuerzo' y 'almuerzo 25' no necesitan IA. Una frase o una fecha sí. */
export function looksNatural(text: string): boolean {
  const t = normalize(text);
  if (DATE_WORDS.test(t) || t.split(' ').length > MAX_PLAIN_WORDS) return true;
  return !(/^(s\/\.?\s*|\$\s*)?\d/.test(t) || /^\S+ [\d.,]+$/.test(t));
}

/** Respuesta sin IA: onboarding o atajos. */
export function handle(store: Store, text: string, today: Day): string {
  if (!store.step) return startOnboarding(store);
  if (!store.configured) return onboard(store, text, today);
  return execute(store, parse(text, aliasesOf(store.ledger())), today);
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
    store.setPending({ text: prompt, question: cmd.question, at: ms });
    return cmd.question;
  }
  return cmd.type === 'unknown' ? fallback.notUnderstood : execute(store, cmd, today);
}

export async function respond(store: Store, ai: Ai | null, text: string, today: Day, ms: number): Promise<string> {
  if (!ai || !store.configured) return handle(store, text, today);

  const cmd: Command = parse(text, aliasesOf(store.ledger()));
  const taken = store.takePending();
  const pending = taken && ms - taken.at <= PENDING_MS ? taken : null;
  const natural = cmd.type === 'unknown' || (cmd.type === 'expense' && looksNatural(text));
  if (!pending && !natural) return execute(store, cmd, today);

  const prompt = pending
    ? `Mensaje anterior: ${pending.text}\nLe preguntaste: ${pending.question}\nRespondió: ${text}`
    : text;
  try {
    return await interpret(store, ai, prompt, today, ms);
  } catch (err) {
    if (!(err instanceof AiUnavailable)) throw err;
    if (cmd.type === 'unknown') return fallback.aiDown;
    return fallback.aiDownSaved(execute(store, cmd, today));
  }
}

export async function respondToImage(store: Store, ai: Ai | null, image: Image, caption: string, today: Day, ms: number) {
  if (!store.configured) return onboarding.unfinished;
  if (!ai) return fallback.photoNoAi;
  const note = caption ? `\nNota del usuario: ${caption}` : '';
  try {
    return await interpret(store, ai, `Interpreta esta captura.${note}`, today, ms, image);
  } catch (err) {
    if (!(err instanceof AiUnavailable)) throw err;
    return fallback.photoFailed;
  }
}
