import { describe, expect, test } from 'bun:test';
import { cycleEndOf, snapshot, type Card, type Income, type Ledger, type Txn } from '../src/engine';

// 2026-11-04 es miércoles; el domingo siguiente es 2026-11-08.
const WED = '2026-11-04';
const weekly: Income = { id: 1, name: 'semana', kind: 'weekly', amount: 40_000, weekday: 0, days: [] };
const cmr: Card = { id: 1, name: 'CMR', aliases: ['cmr'], limit: 50_000, closeDay: 20, dueDay: 5 };

let nextId = 1;
const txn = (p: Partial<Txn>): Txn => ({
  id: nextId++, day: '2026-11-01', kind: 'expense', amount: 0, description: '', cardId: null, fixedId: null, incomeId: null, ...p,
});
const ledger = (p: Partial<Ledger> = {}): Ledger => ({
  txns: [], cards: [cmr], fixed: [], incomes: [weekly], savingGoal: 0, ...p,
});
const cash = (amount: number, day = '2026-11-01') => txn({ kind: 'adjust', amount, day });

describe('ciclo', () => {
  test('a mitad de semana termina el próximo domingo', () => {
    expect(cycleEndOf(ledger(), WED)).toBe('2026-11-08');
  });

  test('el domingo sin ingreso el ciclo termina hoy, y con ingreso sigue una semana', () => {
    const sunday = '2026-11-08';
    expect(cycleEndOf(ledger(), sunday)).toBe(sunday);
    const paid = ledger({ txns: [txn({ kind: 'income', amount: 40_000, incomeId: 1, day: sunday })] });
    expect(cycleEndOf(paid, sunday)).toBe('2026-11-15');
  });
});

describe('libre', () => {
  test('resta los fijos que vencen antes del domingo y no los de después', () => {
    const fixed = [
      { id: 1, name: 'internet', amount: 8_000, day: 6, since: '2026-10-01' },
      { id: 2, name: 'luz', amount: 5_000, day: 20, since: '2026-10-01' },
    ];
    const s = snapshot(ledger({ cards: [], txns: [cash(30_000)], fixed }), WED);
    expect(s.fixedTotal).toBe(8_000);
    expect(s.libre).toBe(22_000);
  });

  test('un fijo pagado deja de restar', () => {
    const fixed = [{ id: 1, name: 'internet', amount: 8_000, day: 6, since: '2026-10-01' }];
    const txns = [cash(30_000), txn({ amount: 8_000, fixedId: 1, day: '2026-11-03' })];
    const s = snapshot(ledger({ cards: [], txns, fixed }), WED);
    expect(s.fixedTotal).toBe(0);
    expect(s.libre).toBe(22_000);
  });

  test('un fijo vencido antes de registrarlo no se cobra', () => {
    const fixed = [{ id: 1, name: 'internet', amount: 8_000, day: 1, since: WED }];
    expect(snapshot(ledger({ txns: [cash(30_000)], fixed }), WED).fixedTotal).toBe(0);
  });

  test('una compra con tarjeta no baja el saldo, pero sí el libre', () => {
    const base = snapshot(ledger({ txns: [cash(30_000)] }), WED);
    const s = snapshot(ledger({ txns: [cash(30_000), txn({ kind: 'purchase', amount: 18_000, cardId: 1, day: WED })] }), WED);
    expect(s.saldo).toBe(30_000);
    expect(s.cards[0]!.debt).toBe(18_000);
    expect(s.libre).toBeLessThan(base.libre);
  });

  test('pagar la tarjeta no cuenta como gasto nuevo', () => {
    const txns = [
      cash(30_000),
      txn({ kind: 'purchase', amount: 10_000, cardId: 1, day: '2026-11-02' }),
      txn({ kind: 'payment', amount: 10_000, cardId: 1, day: WED }),
    ];
    const s = snapshot(ledger({ txns }), WED);
    expect(s.saldo).toBe(20_000);
    expect(s.cards[0]!.debt).toBe(0);
    expect(s.cards[0]!.reserve).toBe(0);
    expect(s.libre).toBe(20_000);
  });

  test('ahorro apartado no baja el saldo real, pero sí el libre', () => {
    const s = snapshot(ledger({ txns: [cash(30_000), txn({ kind: 'saving', amount: 5_000, day: WED })] }), WED);
    expect(s.saldo).toBe(30_000);
    expect(s.libre).toBe(25_000);
  });

  test('una quincena esperada no suma hasta que llega', () => {
    const quincena: Income = { id: 2, name: 'quincena', kind: 'monthly', amount: 35_000, weekday: null, days: [5] };
    const s = snapshot(ledger({ cards: [], incomes: [weekly, quincena], txns: [cash(10_000)] }), WED);
    expect(s.libre).toBe(10_000);
  });
});

describe('apartado de tarjeta', () => {
  const purchase = (day: string) => txn({ kind: 'purchase', amount: 40_000, cardId: 1, day });

  test('crece a medida que se acerca el día en que sale la cuenta', () => {
    const txns = [cash(100_000), purchase('2026-10-21')];
    const early = snapshot(ledger({ txns }), '2026-10-22').cards[0]!;
    const late = snapshot(ledger({ txns }), '2026-11-18').cards[0]!;
    expect(early.reserve).toBeLessThan(late.reserve);
    expect(late.reserve).toBe(40_000);
  });

  test('con la cuenta emitida y sin pagar se aparta completa', () => {
    const txns = [cash(100_000), purchase('2026-10-15')];
    const c = snapshot(ledger({ txns }), '2026-10-22').cards[0]!;
    expect(c.billed).toBe(40_000);
    expect(c.reserve).toBe(40_000);
  });

  test('sin deuda no aparta nada', () => {
    expect(snapshot(ledger({ txns: [cash(100_000)] }), WED).reserve).toBe(0);
  });
});

describe('estados', () => {
  // Miércoles: quedan 4 días de 7. Con 700 de presupuesto, el ritmo es 100 al día.
  const spentBy = (amount: number) =>
    snapshot(ledger({ cards: [], txns: [cash(70_000, '2026-11-01'), txn({ amount, day: '2026-11-02' })] }), WED);

  test('al ritmo: normal', () => expect(spentBy(30_000).state).toBe('normal'));
  test('gasta poco: sobrado', () => expect(spentBy(5_000).state).toBe('sobrado'));
  test('gasta mucho: suave', () => expect(spentBy(50_000).state).toBe('suave'));
  test('sin plata libre: alerta', () => {
    const s = spentBy(80_000);
    expect(s.state).toBe('alerta');
    expect(s.alert?.type).toBe('negative');
  });

  test('el día de pago sin ingreso no finge que estás sobrado', () => {
    const s = snapshot(ledger({ cards: [], txns: [cash(5_000)] }), '2026-11-08');
    expect(s.state).toBe('normal');
  });

  test('empezar a mitad de ciclo con plata no cuenta como ir sobrado', () => {
    const s = snapshot(ledger({ cards: [], txns: [cash(100_000, '2026-11-06')] }), '2026-11-06');
    expect(s.state).toBe('normal');
  });

  test('usar 80% de la línea pide calma aunque haya plata', () => {
    const txns = [cash(200_000), txn({ kind: 'purchase', amount: 40_000, cardId: 1, day: WED })];
    const s = snapshot(ledger({ txns }), WED);
    expect(s.state).toBe('suave');
    expect(s.lineWarning).toEqual({ card: 'CMR', used: 0.8 });
  });

  test('bajo 80% de la línea no avisa', () => {
    const txns = [cash(200_000), txn({ kind: 'purchase', amount: 39_000, cardId: 1, day: WED })];
    expect(snapshot(ledger({ txns }), WED).lineWarning).toBeNull();
  });

  test('pasarse de la línea de S/ 500 obliga a depositar la diferencia', () => {
    const txns = [cash(100_000), txn({ kind: 'purchase', amount: 56_000, cardId: 1, day: WED })];
    const s = snapshot(ledger({ txns }), WED);
    expect(s.state).toBe('alerta');
    expect(s.alert).toEqual({ type: 'over_limit', card: 'CMR', amount: 6_000 });
    expect(s.cards[0]!.reserve).toBeGreaterThanOrEqual(6_000);
  });

  test('si lo seguro no alcanza para pagar la tarjeta, avisa cuánto falta', () => {
    const txns = [cash(1_000), txn({ kind: 'purchase', amount: 45_000, cardId: 1, day: '2026-11-17' })];
    const s = snapshot(ledger({ txns }), '2026-11-18');
    expect(s.alert).toEqual({ type: 'gap', card: 'CMR', amount: 44_000 });
  });

  test('una deuda grande a semanas de pagar, con ingresos que la cubren, no alarma', () => {
    const txns = [cash(30_000), txn({ kind: 'purchase', amount: 45_000, cardId: 1, day: '2026-10-22' })];
    expect(snapshot(ledger({ txns }), '2026-10-22').alert).toBeNull();
  });
});
