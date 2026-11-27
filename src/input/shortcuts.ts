// Convierte lo que escribes en el chat en un comando. No toca la base de datos.
import { isCategory, type Category } from '../domain/categories';
import type { Command } from '../domain/command';
import { WEEKDAYS } from '../domain/dates';
import type { Aliases } from '../domain/ledger';
import { isSaneRate, parseAmount } from '../domain/money';
import { normalize } from '../domain/normalize';

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

/** Quita '$', 'usd' o 'dolares' (gasto en dólares) y '#categoria' del texto. */
function takeTags(text: string) {
  let t = text;
  let currency: 'USD' | undefined;
  let category: Category | undefined;
  const tag = t.match(/(?:^| )#(\S+)/);
  if (tag && isCategory(tag[1]!)) {
    category = tag[1];
    t = t.replace(tag[0], ' ');
  }
  if (/\$\s*(?=\d)/.test(t)) {
    currency = 'USD';
    t = t.replace(/\$\s*(?=\d)/, '');
  } else if (/(?:^| )(usd|dolares|dolar|dls)(?= |$)/.test(t)) {
    currency = 'USD';
    t = t.replace(/(?:^| )(usd|dolares|dolar|dls)(?= |$)/, ' ');
  }
  return { text: t.replace(/\s+/g, ' ').trim(), currency, category };
}

const withTags = <T extends object>(cmd: T, tags: { currency?: 'USD'; category?: Category }, category = true) => ({
  ...cmd,
  ...(tags.currency && { currency: tags.currency }),
  ...(category && tags.category && { category: tags.category }),
});

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
  if (/^\/?(mes|resumen mes|resumen del mes)$/.test(t)) return { type: 'month', offset: 0 };
  if (/^\/?(mes pasado|resumen mes pasado|resumen del mes pasado)$/.test(t)) return { type: 'month', offset: -1 };
  if ((m = t.match(/^(?:dolar|tipo de cambio|tc) (\d+(?:[.,]\d+)?)$/))) {
    const rate = Number(m[1]!.replace(',', '.'));
    if (isSaneRate(rate)) return { type: 'set_rate', rate };
  }

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
  const tags = takeTags(t);
  if ((m = tags.text.match(/^\+\s*(\S+)\s*(.*)$/))) {
    const amount = parseAmount(m[1]!);
    if (amount) return withTags({ type: 'income' as const, amount, description: m[2]!.trim() }, tags, false);
  }
  if ((m = tags.text.match(/^(?:puedo|se puede)(?: gastar| comprar| pagar)?\s+(.+)$/))) {
    const s = spending(m[1]!, aliases);
    if (s) return withTags({ type: 'ask' as const, ...s }, tags, false);
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

  const s = spending(tags.text, aliases);
  return s ? withTags({ type: 'expense' as const, ...s }, tags) : { type: 'unknown' };
}
