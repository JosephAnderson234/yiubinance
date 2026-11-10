// Convierte lo que escribes en el chat en un comando. No toca la base de datos.
import { WEEKDAYS, type Day } from './dates';
import { parseAmount } from './money';

export type Command =
  | { type: 'expense'; amount: number; description: string; cardId: number | null; day?: Day }
  | { type: 'ask'; amount: number; description: string; cardId: number | null }
  | { type: 'income'; amount: number; description: string; day?: Day }
  | { type: 'pay'; cardId: number; amount: number | null }
  | { type: 'statement'; cardId: number; amount: number }
  | { type: 'balance'; amount: number }
  | { type: 'saving'; amount: number }
  | { type: 'status' }
  | { type: 'undo' }
  | { type: 'recent' }
  | { type: 'settings' }
  | { type: 'help' }
  | { type: 'start' }
  | { type: 'set_fixed'; name: string; amount: number; day: number }
  | { type: 'set_income'; name: string; amount: number; weekday: number | null; days: number[] }
  | { type: 'set_card'; name: string; limit: number; closeDay: number; dueDay: number; debt: number }
  | { type: 'set_goal'; amount: number }
  | { type: 'remove'; what: 'fijo' | 'ingreso' | 'tarjeta'; name: string }
  | { type: 'unknown' };

export type Aliases = Map<string, number>;

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Quita un alias de tarjeta del final del texto, si lo hay. */
function takeCard(text: string, aliases: Aliases) {
  const sorted = [...aliases.keys()].sort((a, b) => b.length - a.length);
  for (const alias of sorted) {
    if (text === alias) return { text: '', cardId: aliases.get(alias)! };
    if (text.endsWith(` ${alias}`)) {
      return { text: text.slice(0, -alias.length - 1).trim(), cardId: aliases.get(alias)! };
    }
  }
  return { text, cardId: null };
}

/** Acepta '25 almuerzo' y 'almuerzo 25'. */
function amountAndText(text: string) {
  const parts = text.split(' ').filter(Boolean);
  if (!parts.length) return null;
  const first = parseAmount(parts[0]!);
  if (first !== null) return { amount: first, text: parts.slice(1).join(' ') };
  const last = parseAmount(parts[parts.length - 1]!);
  if (last !== null) return { amount: last, text: parts.slice(0, -1).join(' ') };
  return null;
}

function spending(text: string, aliases: Aliases) {
  const parsed = amountAndText(text);
  if (!parsed || parsed.amount <= 0) return null;
  const { text: rest, cardId } = takeCard(parsed.text, aliases);
  const description = rest.replace(/^(en|de|para) /, '').trim() || 'gasto';
  return { amount: parsed.amount, description, cardId };
}

const validDay = (n: number) => Number.isInteger(n) && n >= 1 && n <= 31;

export function parse(raw: string, aliases: Aliases): Command {
  const t = normalize(raw).replace(/s\/\.?\s*(?=\d)/g, '');
  let m: RegExpMatchArray | null;

  if (/^\/start\b/.test(t)) return { type: 'start' };
  if (/^\/?(ayuda|help)$/.test(t)) return { type: 'help' };
  if (/^\/?(como voy|estado|saldo)$/.test(t)) return { type: 'status' };
  if (/^\/?(deshacer|borrar|undo)$/.test(t)) return { type: 'undo' };
  if (/^\/?ultimos$/.test(t)) return { type: 'recent' };
  if (/^\/?(ajustes|config)$/.test(t)) return { type: 'settings' };

  if ((m = t.match(/^borrar (fijo|ingreso|tarjeta) (.+)$/))) {
    return { type: 'remove', what: m[1] as 'fijo' | 'ingreso' | 'tarjeta', name: m[2]! };
  }
  if ((m = t.match(/^fijo (.+) (\S+) dia (\d+)$/))) {
    const amount = parseAmount(m[2]!);
    const day = Number(m[3]);
    if (amount && validDay(day)) return { type: 'set_fixed', name: m[1]!, amount, day };
  }
  if ((m = t.match(/^ingreso (.+) (\S+) dias? ([\d, ]+)$/))) {
    const amount = parseAmount(m[2]!);
    const days = m[3]!.split(/[, ]+/).filter(Boolean).map(Number);
    if (amount && days.length && days.every(validDay)) {
      return { type: 'set_income', name: m[1]!, amount, weekday: null, days };
    }
  }
  if ((m = t.match(/^ingreso (.+) (\S+) (\w+)$/))) {
    const amount = parseAmount(m[2]!);
    const wd = WEEKDAYS.indexOf(m[3]!);
    if (amount && wd >= 0) return { type: 'set_income', name: m[1]!, amount, weekday: wd, days: [] };
  }
  if ((m = t.match(/^tarjeta (.+) linea (\S+) cierre (\d+) pago (\d+)(?: deuda (\S+))?$/))) {
    const limit = parseAmount(m[2]!);
    const closeDay = Number(m[3]);
    const dueDay = Number(m[4]);
    const debt = m[5] ? parseAmount(m[5]) : 0;
    if (limit && debt !== null && validDay(closeDay) && validDay(dueDay)) {
      return { type: 'set_card', name: m[1]!, limit, closeDay, dueDay, debt };
    }
  }
  if ((m = t.match(/^meta ahorro (\S+)$/))) {
    const amount = parseAmount(m[1]!);
    if (amount !== null) return { type: 'set_goal', amount };
  }

  if ((m = t.match(/^saldo (\S+)$/))) {
    const amount = parseAmount(m[1]!);
    if (amount !== null) return { type: 'balance', amount };
  }
  if ((m = t.match(/^(retiro )?ahorro (\S+)$/))) {
    const amount = parseAmount(m[2]!);
    if (amount) return { type: 'saving', amount: m[1] ? -amount : amount };
  }
  if ((m = t.match(/^\+\s*(\S+)\s*(.*)$/))) {
    const amount = parseAmount(m[1]!);
    if (amount) return { type: 'income', amount, description: m[2]!.trim() };
  }
  if ((m = t.match(/^(?:puedo|se puede)(?: gastar| comprar| pagar)?\s+(.+)$/))) {
    const s = spending(m[1]!, aliases);
    if (s) return { type: 'ask', ...s };
  }
  if ((m = t.match(/^(?:cuenta|estado|deuda)\s+(.+)$/))) {
    const parsed = amountAndText(m[1]!);
    const card = parsed && takeCard(parsed.text, aliases);
    if (parsed && card && card.cardId !== null && !card.text) {
      return { type: 'statement', cardId: card.cardId, amount: parsed.amount };
    }
  }
  if ((m = t.match(/^(?:pago|pague)\s+(.+)$/))) {
    const rest = m[1]!;
    const withAmount = amountAndText(rest);
    const card = takeCard(withAmount ? withAmount.text : rest, aliases);
    if (card.cardId !== null && !card.text) {
      return { type: 'pay', cardId: card.cardId, amount: withAmount?.amount ?? null };
    }
  }

  const s = spending(t, aliases);
  return s ? { type: 'expense', ...s } : { type: 'unknown' };
}
