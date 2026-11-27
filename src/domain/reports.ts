// Resúmenes por periodo: cuánto se gastó, en qué, y cómo se compara con el anterior.
import { categorize } from './categories';
import { monthDay, type Day } from './dates';
import type { Ledger, Txn } from './ledger';

export interface MonthReport {
  month: string; // 'YYYY-MM'
  spent: number; // gastos y compras, sin contar fijos
  byCategory: [string, number][]; // de mayor a menor
  fixedPaid: number;
  income: number;
  saved: number; // neto: apartado menos retirado
  previousSpent: number | null; // null si no hay datos del mes anterior
}

const isSpend = (t: Txn) => t.kind === 'expense' || t.kind === 'purchase';
const categoryOf = (t: Txn) => t.category || categorize(t.description);

/** Mes 'YYYY-MM' que contiene `today` desplazado `offset` meses. */
export const monthOf = (today: Day, offset = 0) => monthDay(today, 1, offset).slice(0, 7);

function spentIn(txns: Txn[], month: string) {
  return txns.filter((t) => isSpend(t) && t.fixedId === null && t.day.startsWith(month)).reduce((s, t) => s + t.amount, 0);
}

export function monthReport(l: Ledger, month: string): MonthReport {
  const inMonth = l.txns.filter((t) => t.day.startsWith(month));
  const spends = inMonth.filter((t) => isSpend(t) && t.fixedId === null);
  const byCat = new Map<string, number>();
  for (const t of spends) byCat.set(categoryOf(t), (byCat.get(categoryOf(t)) ?? 0) + t.amount);

  const prevMonth = monthOf(`${month}-01`, -1);
  const hasPrevious = l.txns.some((t) => t.day < `${month}-01` && t.day.startsWith(prevMonth) && !t.auto);

  return {
    month,
    spent: spends.reduce((s, t) => s + t.amount, 0),
    byCategory: [...byCat].sort((a, b) => b[1] - a[1]),
    fixedPaid: inMonth.filter((t) => isSpend(t) && t.fixedId !== null).reduce((s, t) => s + t.amount, 0),
    income: inMonth.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount, 0),
    saved: inMonth.filter((t) => t.kind === 'saving').reduce((s, t) => s + t.amount, 0),
    previousSpent: hasPrevious ? spentIn(l.txns, prevMonth) : null,
  };
}

/** Gasto por categoría en [from, to], sin fijos. */
export function spendByCategory(l: Ledger, from: Day, to: Day): [string, number][] {
  const byCat = new Map<string, number>();
  for (const t of l.txns) {
    if (!isSpend(t) || t.fixedId !== null || t.day < from || t.day > to) continue;
    byCat.set(categoryOf(t), (byCat.get(categoryOf(t)) ?? 0) + t.amount);
  }
  return [...byCat].sort((a, b) => b[1] - a[1]);
}
