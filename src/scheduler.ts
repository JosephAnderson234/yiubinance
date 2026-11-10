// Decide qué avisos tocan ahora. Cada aviso lleva una marca para no repetirse.
import { addDays, diffDays, localDay, localHour, monthDay, nextMonthlyOn, prevMonthly, weekday } from './dates';
import { billedOf, paydayWeekday, snapshot } from './engine';
import { brief } from './messages';
import { fmt } from './money';
import type { Store } from './store';

export interface Notice { flag: string; text: string }

const MORNING = 9;
const EVENING = 20;
const LATE_AFTER_DAYS = 4;
const STOP_ASKING_DAYS = 8;
const IDLE_DAYS = 3;

function weeklySummary(store: Store, today: string): string {
  const l = store.ledger();
  const from = addDays(today, -6);
  const week = l.txns.filter((t) => (t.kind === 'expense' || t.kind === 'purchase') && t.day >= from && t.day <= today);
  const total = week.reduce((s, t) => s + t.amount, 0);
  const byName = new Map<string, number>();
  for (const t of week) byName.set(t.description, (byName.get(t.description) ?? 0) + t.amount);
  const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, a]) => `${n} ${fmt(a)}`);

  const s = snapshot(l, today);
  const lines = [`Resumen de la semana: gastaste ${fmt(total)}.`];
  if (top.length) lines.push(`Lo que más pesó: ${top.join(', ')}.`);
  lines.push('', brief(s), '', '¿Cuánto tienes de verdad en tu cuenta? Responde, por ejemplo: saldo 820');
  if (s.goalLeft > 0) lines.push(`Y si puedes, aparta tu ahorro: ahorro ${s.goalLeft / 100}`);
  return lines.join('\n');
}

export function dueNotices(store: Store, ms: number): Notice[] {
  if (store.get('step') !== 'done') return [];
  const today = localDay(ms);
  const hour = localHour(ms);
  const l = store.ledger();
  const out: Notice[] = [];

  if (hour >= EVENING && weekday(today) === paydayWeekday(l)) {
    out.push({ flag: `summary:${today}`, text: weeklySummary(store, today) });
  }

  if (hour >= MORNING) {
    for (const card of l.cards) {
      const billed = billedOf(l.txns, card, today);
      const alias = card.aliases[0];
      if (prevMonthly(today, card.closeDay) === today) {
        const noted = billed > 0 ? `Salió tu cuenta ${card.name}: ${fmt(billed)} según lo anotado.` : `Hoy sale tu cuenta ${card.name}.`;
        out.push({
          flag: `close:${card.id}:${today}`,
          text: `${noted} Si tu estado dice otro monto, escríbeme: cuenta ${alias} 230. Cuando la pagues: pago ${alias}`,
        });
      }
      if (billed <= 0) continue;
      const due = nextMonthlyOn(today, card.dueDay);
      const left = diffDays(due, today);
      if (left === 2 || left === 0) {
        const when = left === 0 ? 'hoy' : 'en 2 días';
        out.push({
          flag: `due:${card.id}:${today}`,
          text: `Ojo, ${when} vence ${card.name} y sigues debiendo ${fmt(billed)} de esa cuenta.`,
        });
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
            out.push({
              flag: `late:${inc.id}:${expected}`,
              text: `¿Ya te cayó ${inc.name}? Debía llegar hace ${late} días. Si llegó, escribe: +${inc.amount / 100} ${inc.name}`,
            });
          }
        }
      }
    }
  }

  const lastDay = l.txns[l.txns.length - 1]?.day;
  if (hour >= EVENING && lastDay && diffDays(today, lastDay) >= IDLE_DAYS) {
    out.push({
      flag: `idle:${lastDay}`,
      text: `Llevas ${diffDays(today, lastDay)} días sin anotar nada. ¿Gastaste algo? Si no te acuerdas, pásame tu saldo: saldo 820`,
    });
  }

  return out.filter((n) => !store.get(n.flag));
}
