import type { Store } from '../adapters/store';
import type { Day } from '../domain/dates';
import { debtOf } from '../domain/snapshot';

const displayName = (name: string) =>
  name.split(' ').map((w) => (w.length <= 3 ? w.toUpperCase() : w)).join(' ');

/** Crea o actualiza una tarjeta y ajusta su deuda al monto indicado. Devuelve el nombre que se muestra. */
export function saveCard(store: Store, today: Day, c: { name: string; limit: number; closeDay: number; dueDay: number; debt: number }) {
  const words = c.name.split(' ');
  const aliases = words.length === 2 ? [c.name, `${words[1]} ${words[0]}`] : [c.name];
  const shown = displayName(c.name);
  const id = store.upsertCard({ name: shown, aliases, limit: c.limit, closeDay: c.closeDay, dueDay: c.dueDay });
  const delta = c.debt - debtOf(store.ledger().txns, id);
  if (c.debt > 0 && delta !== 0) store.addTxn({ day: today, kind: 'debt_adjust', amount: delta, description: 'deuda inicial', cardId: id, auto: true });
  return shown;
}
