// El libro: movimientos, tarjetas, fijos e ingresos. Todo el dinero va en céntimos.
import type { Day } from './dates';

export type TxnKind =
  | 'expense' // gasto con Yape/débito/efectivo: baja el saldo
  | 'income' // ingreso: sube el saldo
  | 'purchase' // compra con tarjeta: sube la deuda, el saldo no cambia
  | 'payment' // pago de tarjeta: baja saldo y deuda, no es gasto nuevo
  | 'adjust' // corrección de saldo (con signo)
  | 'debt_adjust' // deuda inicial de una tarjeta (con signo)
  | 'saving'; // apartado de ahorro dentro del mismo saldo (con signo)

export interface Txn {
  id: number;
  day: Day;
  kind: TxnKind;
  amount: number;
  description: string;
  cardId: number | null;
  fixedId: number | null;
  incomeId: number | null;
}
export interface Card { id: number; name: string; aliases: string[]; limit: number; closeDay: number; dueDay: number }
export interface Fixed { id: number; name: string; amount: number; day: number; since: Day }
export interface Income { id: number; name: string; kind: 'weekly' | 'monthly'; amount: number; weekday: number | null; days: number[] }
export interface Ledger { txns: Txn[]; cards: Card[]; fixed: Fixed[]; incomes: Income[]; savingGoal: number }

/** Alias de tarjeta ya normalizado → id de la tarjeta. */
export type Aliases = Map<string, number>;

export function aliasesOf(l: Ledger): Aliases {
  const map: Aliases = new Map();
  for (const c of l.cards) for (const a of c.aliases) map.set(a, c.id);
  return map;
}
