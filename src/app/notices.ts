// Decide qué avisos tocan ahora. Cada aviso lleva una marca para no repetirse.
import type { Flag, Store } from '../adapters/store';
import { addDays, diffDays, localDay, localHour, monthDay, nextMonthlyOn, prevMonthly, weekday, type Day } from '../domain/dates';
import type { Ledger } from '../domain/ledger';
import { monthOf, monthReport, spendByCategory } from '../domain/reports';
import { billedOf, paydayWeekday, snapshot } from '../domain/snapshot';
import { notices as say } from '../replies/es';

export interface Notice { flag: Flag; text: string }

const MORNING = 9;
const EVENING = 20;
const LATE_AFTER_DAYS = 4;
const STOP_ASKING_DAYS = 8;
const IDLE_DAYS = 3;
const TOP_SPENDS = 3;

function weeklySummary(l: Ledger, today: Day): string {
  const from = addDays(today, -6);
  const byCategory = spendByCategory(l, from, today);
  const total = byCategory.reduce((s, [, a]) => s + a, 0);
  return say.weeklySummary(total, byCategory.slice(0, TOP_SPENDS), snapshot(l, today));
}

export function dueNotices(store: Store, ms: number): Notice[] {
  if (!store.configured) return [];
  const today = localDay(ms);
  const hour = localHour(ms);
  const l = store.ledger();
  const out: Notice[] = [];

  if (hour >= EVENING && weekday(today) === paydayWeekday(l)) {
    out.push({ flag: `summary:${today}`, text: weeklySummary(l, today) });
  }

  if (hour >= MORNING) {
    // El primer día del mes, el resumen del mes que cerró. Solo si hubo movimientos.
    if (today.endsWith('-01')) {
      const r = monthReport(l, monthOf(today, -1));
      if (r.spent || r.fixedPaid || r.income) out.push({ flag: `month:${r.month}`, text: say.monthly(r) });
    }

    for (const card of l.cards) {
      const billed = billedOf(l.txns, card, today);
      if (prevMonthly(today, card.closeDay) === today) {
        out.push({ flag: `close:${card.id}:${today}`, text: say.cardClosed(card.name, card.aliases[0]!, billed) });
      }
      if (billed <= 0) continue;
      const left = diffDays(nextMonthlyOn(today, card.dueDay), today);
      if (left === 2 || left === 0) {
        out.push({ flag: `due:${card.id}:${today}`, text: say.cardDue(card.name, left, billed) });
      }
    }

    for (const inc of l.incomes.filter((i) => i.kind === 'monthly')) {
      for (const day of inc.days) {
        for (const offset of [0, -1]) {
          const expected = monthDay(today, day, offset);
          const late = diffDays(today, expected);
          if (late < LATE_AFTER_DAYS || late >= STOP_ASKING_DAYS) continue;
          const received = l.txns.some((t) => t.kind === 'income' && t.incomeId === inc.id && t.day >= addDays(expected, -3));
          if (!received) {
            out.push({ flag: `late:${inc.id}:${expected}`, text: say.incomeLate(inc.name, late, inc.amount) });
          }
        }
      }
    }
  }

  const lastDay = l.txns[l.txns.length - 1]?.day;
  if (hour >= EVENING && lastDay && diffDays(today, lastDay) >= IDLE_DAYS) {
    out.push({ flag: `idle:${lastDay}`, text: say.idle(diffDays(today, lastDay)) });
  }

  return out.filter((n) => !store.hasFlag(n.flag));
}
