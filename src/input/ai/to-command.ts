// Lo que dice la IA es una propuesta: aquí se valida antes de tocar el libro.
import type { Command } from '../../domain/command';
import { addDays, type Day } from '../../domain/dates';
import type { Aliases } from '../../domain/ledger';
import { normalize } from '../../domain/normalize';
import type { Action, Reading } from './prompt';

const MAX_CENTS = 100_000_000;
const MAX_DAYS_AGO = 60;
const CASH_WORDS = ['yape', 'plin', 'debito', 'efectivo', 'cash', 'transferencia', 'bcp', 'bbva', 'interbank', 'scotiabank'];
const IMAGE_ACTIONS: Action[] = ['expense', 'income', 'clarify', 'unknown'];

export type Interpreted = Command | { type: 'clarify'; question: string };

export function toCommand(r: Reading, aliases: Aliases, today: Day, fromImage = false): Interpreted {
  const clarify = (question: string): Interpreted => ({ type: 'clarify', question });
  if (fromImage && !IMAGE_ACTIONS.includes(r.action)) return { type: 'unknown' };

  const amount = Math.round(Math.abs(r.amount) * 100);
  if (amount > MAX_CENTS) return clarify('Ese monto se ve raro. ¿Cuánto fue?');

  const ago = Number.isInteger(r.days_ago) && r.days_ago > 0 && r.days_ago <= MAX_DAYS_AGO ? r.days_ago : 0;
  const day = addDays(today, -ago);
  const description = normalize(r.description) || 'gasto';

  const name = normalize(r.card);
  const cardId = aliases.get(name) ?? null;
  const unknownCard = name !== '' && cardId === null && !CASH_WORDS.includes(name);
  const cards = [...aliases.keys()].join(', ');

  switch (r.action) {
    case 'expense':
    case 'ask':
      if (!amount) return clarify('¿Cuánto fue?');
      if (unknownCard) return clarify(`No tengo esa tarjeta. ¿Fue con ${cards} o con Yape?`);
      return r.action === 'ask'
        ? { type: 'ask', amount, description, cardId }
        : { type: 'expense', amount, description, cardId, day };
    case 'income':
      if (!amount) return clarify('¿Cuánto te entró?');
      return { type: 'income', amount, description: r.description ? description : '', day };
    case 'card_payment':
      if (cardId === null) return clarify(`¿A qué tarjeta? Tengo: ${cards}.`);
      return { type: 'pay', cardId, amount: amount || null };
    case 'card_statement':
      if (cardId === null) return clarify(`¿De qué tarjeta? Tengo: ${cards}.`);
      return { type: 'statement', cardId, amount };
    case 'balance':
      if (!amount) return clarify('¿Cuánto tienes ahora?');
      return { type: 'balance', amount };
    case 'saving':
      if (!amount) return clarify('¿Cuánto quieres apartar?');
      return { type: 'saving', amount: r.amount < 0 ? -amount : amount };
    case 'status':
      return { type: 'status' };
    case 'recent':
      return { type: 'recent' };
    case 'undo':
      return { type: 'undo' };
    case 'clarify':
      return clarify(r.question.trim() || '¿Me das más detalle?');
    case 'unknown':
      return { type: 'unknown' };
  }
}
