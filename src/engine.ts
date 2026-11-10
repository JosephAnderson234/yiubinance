// Lógica financiera pura: recibe el libro y una fecha, devuelve cómo vas.
import { addDays, diffDays, monthDay, nextMonthlyAfter, prevMonthly, weekday, type Day } from './dates';

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

export type State = 'sobrado' | 'normal' | 'suave' | 'alerta';
export type Alert =
  | { type: 'over_limit'; card: string; amount: number }
  | { type: 'billed'; card: string; amount: number }
  | { type: 'gap'; card: string; amount: number }
  | { type: 'negative'; amount: number };

export interface CardStatus {
  card: Card;
  debt: number;
  available: number;
  over: number; // lo que excede la línea: se deposita ya
  billed: number; // estado de cuenta emitido y sin pagar
  target: Day; // próxima fecha en que sale la cuenta
  fraction: number;
  reserve: number;
}

export interface Snapshot {
  today: Day;
  cycleStart: Day;
  cycleEnd: Day;
  daysLeft: number;
  saldo: number;
  savedTotal: number;
  goalLeft: number;
  fixedPending: { name: string; amount: number; date: Day }[];
  fixedTotal: number;
  cards: CardStatus[];
  reserve: number;
  libre: number;
  perDay: number;
  spent: number;
  budget: number;
  ratio: number;
  state: State;
  alert: Alert | null;
  lineWarning: { card: string; used: number } | null;
}

const CYCLE_DAYS = 7;
const LINE_WARNING = 0.8; // desde aquí la tarjeta pide calma aunque el ritmo vaya bien
const DEFAULT_PAYDAY = 0; // domingo

export const saldoOf = (txns: Txn[]) =>
  txns.reduce((sum, t) => {
    if (t.kind === 'income' || t.kind === 'adjust') return sum + t.amount;
    if (t.kind === 'expense' || t.kind === 'payment') return sum - t.amount;
    return sum;
  }, 0);

export function debtOf(txns: Txn[], cardId: number, until?: Day) {
  return txns.reduce((sum, t) => {
    if (t.cardId !== cardId || (until && t.day > until)) return sum;
    if (t.kind === 'purchase' || t.kind === 'debt_adjust') return sum + t.amount;
    if (t.kind === 'payment') return sum - t.amount;
    return sum;
  }, 0);
}

/** Lo facturado en la última cuenta que aún no se ha pagado. */
export function billedOf(txns: Txn[], card: Card, today: Day) {
  const close = prevMonthly(today, card.closeDay);
  const paidAfter = txns
    .filter((t) => t.kind === 'payment' && t.cardId === card.id && t.day > close && t.day <= today)
    .reduce((s, t) => s + t.amount, 0);
  return Math.max(0, debtOf(txns, card.id, close) - paidAfter);
}

export const weeklyIncomes = (l: Ledger) => l.incomes.filter((i) => i.kind === 'weekly');

export const paydayWeekday = (l: Ledger) => weeklyIncomes(l)[0]?.weekday ?? DEFAULT_PAYDAY;

/** Fin del ciclo: el próximo día de pago. Si hoy toca y aún no llegó, el ciclo termina hoy. */
export function cycleEndOf(l: Ledger, today: Day): Day {
  const ahead = (paydayWeekday(l) - weekday(today) + 7) % 7;
  if (ahead > 0) return addDays(today, ahead);
  const source = weeklyIncomes(l)[0];
  const received = source
    ? l.txns.some((t) => t.kind === 'income' && t.incomeId === source.id && t.day === today)
    : true;
  return received ? addDays(today, CYCLE_DAYS) : today;
}

/** Suma de ingresos semanales seguros y cantidad de pagos en (from, to]. */
function weeklyBetween(l: Ledger, from: Day, to: Day) {
  let count = 0;
  let amount = 0;
  for (const inc of weeklyIncomes(l)) {
    let n = 0;
    for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (weekday(d) === inc.weekday) n++;
    count = Math.max(count, n);
    amount += n * inc.amount;
  }
  return { count, amount };
}

/** Fijos que vencen hasta `until` y aún no se pagan. Lo vencido antes de registrarlos no cuenta. */
export function pendingFixed(l: Ledger, today: Day, until: Day) {
  const out: { name: string; amount: number; date: Day }[] = [];
  for (const f of l.fixed) {
    for (let m = 0; ; m++) {
      const date = monthDay(today, f.day, m);
      if (date > until) break;
      if (date < f.since) continue;
      const month = date.slice(0, 7);
      const paid = l.txns.some((t) => t.fixedId === f.id && t.day.slice(0, 7) === month);
      if (!paid) out.push({ name: f.name, amount: f.amount, date });
    }
  }
  return out;
}

function cardStatus(l: Ledger, card: Card, today: Day): CardStatus {
  const debt = debtOf(l.txns, card.id);
  const over = Math.max(0, debt - card.limit);
  const billed = Math.min(debt, billedOf(l.txns, card, today));
  const target = nextMonthlyAfter(today, card.closeDay);
  const prev = prevMonthly(today, card.closeDay);
  // Reparte la deuda entre los pagos semanales que faltan: cerca de la fecha, casi todo apartado.
  const left = weeklyBetween(l, today, target).count;
  const total = Math.max(weeklyBetween(l, prev, target).count, left + 1);
  const fraction = (total - left) / total;
  const firm = Math.min(debt, billed + over);
  const reserve = Math.round(firm + (debt - firm) * fraction);
  return { card, debt, available: card.limit - debt, over, billed, target, fraction, reserve };
}

function findAlert(l: Ledger, cards: CardStatus[], today: Day, cash: number, libre: number): Alert | null {
  const over = cards.find((c) => c.over > 0);
  if (over) return { type: 'over_limit', card: over.card.name, amount: over.over };

  // ¿Alcanza lo que hay más lo que entra seguro para pagar cada tarjeta a tiempo?
  let owed = 0;
  for (const c of [...cards].sort((a, b) => a.target.localeCompare(b.target))) {
    owed += c.debt;
    const fixed = pendingFixed(l, today, c.target).reduce((s, f) => s + f.amount, 0);
    const available = cash + weeklyBetween(l, today, c.target).amount - fixed;
    if (c.debt > 0 && owed > available) return { type: 'gap', card: c.card.name, amount: owed - available };
  }

  const billed = cards.find((c) => c.billed > 0);
  if (billed && libre < 0) return { type: 'billed', card: billed.card.name, amount: billed.billed };
  return libre < 0 ? { type: 'negative', amount: -libre } : null;
}

export function snapshot(l: Ledger, today: Day): Snapshot {
  const cycleEnd = cycleEndOf(l, today);
  const cycleStart = addDays(cycleEnd, -CYCLE_DAYS);
  const daysLeft = Math.max(1, diffDays(cycleEnd, today));

  const saldo = saldoOf(l.txns);
  const savings = l.txns.filter((t) => t.kind === 'saving');
  const savedTotal = savings.reduce((s, t) => s + t.amount, 0);
  const savedCycle = savings.filter((t) => t.day >= cycleStart).reduce((s, t) => s + t.amount, 0);
  const goalLeft = Math.max(0, l.savingGoal - savedCycle);

  const fixedPending = pendingFixed(l, today, cycleEnd);
  const fixedTotal = fixedPending.reduce((s, f) => s + f.amount, 0);
  const cards = l.cards.map((c) => cardStatus(l, c, today));
  const reserve = cards.reduce((s, c) => s + c.reserve, 0);
  const libre = saldo - savedTotal - goalLeft - fixedTotal - reserve;

  // Una compra con tarjeta solo baja el libre en la parte ya apartada, y así se cuenta en el ritmo.
  const cash = l.txns
    .filter((t) => t.kind === 'expense' && t.day >= cycleStart)
    .reduce((s, t) => s + t.amount, 0);
  const onCard = cards.reduce((sum, c) => {
    const bought = l.txns
      .filter((t) => t.kind === 'purchase' && t.cardId === c.card.id && t.day >= cycleStart)
      .reduce((s, t) => s + t.amount, 0);
    return sum + bought * c.fraction;
  }, 0);
  const spent = Math.round(cash + onCard);
  const budget = libre + spent;
  const perDay = Math.floor(libre / daysLeft / 100) * 100;

  // Si el historial empezó a mitad de ciclo, el ritmo se mide solo con los días que hubo.
  const firstDay = l.txns[0]?.day ?? today;
  const trackedFrom = firstDay > cycleStart ? firstDay : cycleStart;
  const cycleDays = Math.max(1, diffDays(cycleEnd, trackedFrom));

  let ratio = 1;
  if (budget <= 0) ratio = 0;
  else if (cycleEnd !== today) ratio = libre / daysLeft / (budget / cycleDays);

  const alert = findAlert(l, cards, today, saldo - savedTotal, libre);
  const full = cards.find((c) => c.card.limit > 0 && c.debt / c.card.limit >= LINE_WARNING);
  const lineWarning = full ? { card: full.card.name, used: full.debt / full.card.limit } : null;
  const state: State = alert ? 'alerta' : ratio < 0.75 || lineWarning ? 'suave' : ratio > 1.25 ? 'sobrado' : 'normal';

  return {
    today, cycleStart, cycleEnd, daysLeft, saldo, savedTotal, goalLeft, fixedPending, fixedTotal,
    cards, reserve, libre, perDay, spent, budget, ratio, state, alert, lineWarning,
  };
}
