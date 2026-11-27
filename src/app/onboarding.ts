// Configuración inicial paso a paso: saldo, tarjetas, ingresos, fijos y meta de ahorro.
import type { Step, Store } from '../adapters/store';
import { WEEKDAYS, type Day } from '../domain/dates';
import { parseAmount } from '../domain/money';
import { normalize } from '../domain/normalize';
import { snapshot } from '../domain/snapshot';
import { onboarding as say } from '../replies/es';
import { saveCard } from './cards';

const isDay = (n: number) => Number.isInteger(n) && n >= 1 && n <= 31;

export function startOnboarding(store: Store): string {
  store.step = 'saldo';
  return say.welcome(say.prompts.saldo);
}

export function onboard(store: Store, text: string, today: Day): string {
  const step = store.step as Exclude<Step, 'done'>;
  const t = normalize(text);
  const parts = t.split(' ');
  const retry = say.retry(say.prompts[step]);
  const next = (s: Exclude<Step, 'done'>) => {
    store.step = s;
    return say.prompts[s];
  };

  if (step === 'saldo') {
    const amount = parseAmount(t);
    if (amount === null) return retry;
    store.addTxn({ day: today, kind: 'adjust', amount, description: 'saldo inicial', auto: true });
    return next('tarjetas');
  }
  if (step === 'tarjetas') {
    if (t === 'listo' || t === 'no') return next('semana');
    const rows = text.split('\n').map((r) => normalize(r).split(' '));
    const parsed = rows.map((r) => ({
      name: r.slice(0, -4).join(' '),
      limit: parseAmount(r[r.length - 4] ?? ''),
      debt: parseAmount(r[r.length - 3] ?? ''),
      closeDay: Number(r[r.length - 2]),
      dueDay: Number(r[r.length - 1]),
    }));
    if (parsed.some((c) => !c.name || !c.limit || c.debt === null || !isDay(c.closeDay) || !isDay(c.dueDay))) return retry;
    return say.cardsSaved(parsed.map((c) => saveCard(store, today, { ...c, limit: c.limit!, debt: c.debt! })));
  }
  if (step === 'semana') {
    const amount = parseAmount(parts[0] ?? '');
    const wd = WEEKDAYS.indexOf(parts[1] ?? '');
    if (parts.length !== 2 || !amount || wd < 0) return retry;
    store.upsertIncome({ name: 'semana', amount, weekday: wd, days: [] });
    return next('quincena');
  }
  if (step === 'quincena') {
    if (t === 'no') return next('fijos');
    const amount = parseAmount(parts[0] ?? '');
    const days = parts.slice(1).join(',').split(',').filter(Boolean).map(Number);
    if (!amount || !days.length || !days.every(isDay)) return retry;
    store.upsertIncome({ name: 'quincena', amount, weekday: null, days });
    return next('fijos');
  }
  if (step === 'fijos') {
    if (t === 'listo' || t === 'no') return next('ahorro');
    const rows = text.split('\n').map((r) => normalize(r).split(' '));
    const parsed = rows.map((r) => ({
      name: r.slice(0, -2).join(' '),
      amount: parseAmount(r[r.length - 2] ?? ''),
      day: Number(r[r.length - 1]),
    }));
    if (parsed.some((f) => !f.name || !f.amount || !isDay(f.day))) return retry;
    for (const f of parsed) store.upsertFixed({ name: f.name, amount: f.amount!, day: f.day, since: today });
    return say.fixedSaved(parsed.map((f) => f.name));
  }
  if (step === 'ahorro') {
    const amount = parseAmount(t);
    if (amount === null) return retry;
    store.savingGoal = amount;
    store.step = 'done';
    return say.done(snapshot(store.ledger(), today));
  }
  return retry;
}
