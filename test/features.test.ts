import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Access } from '../src/adapters/access';
import { Bot } from '../src/adapters/bot';
import { Store } from '../src/adapters/store';
import { refreshRate } from '../src/app/fx';
import { dueNotices } from '../src/app/notices';
import { categorize } from '../src/domain/categories';
import { monthReport } from '../src/domain/reports';
import { snapshot } from '../src/domain/snapshot';
import { Ai, toCommand, type Provider, type Reading } from '../src/input/ai';
import { handle, respond } from '../src/input/router';
import { parse } from '../src/input/shortcuts';

const DAY = '2026-11-04'; // miércoles
const MS = Date.parse('2026-11-04T12:00:00-05:00');
const at = (day: string, hour: number) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00-05:00`);
const say = (s: Store, ...msgs: string[]) => msgs.map((m) => handle(s, m, DAY)).at(-1)!;

function configured() {
  const s = new Store();
  say(s, '/start', '1000', 'cmr 500 100 20 5', 'listo', '400 domingo', 'no', 'internet 80 25', 'listo', '0');
  return s;
}

const reading = (p: Partial<Reading> = {}): Reading => ({
  action: 'expense', amount: 15, description: 'menu', card: '', days_ago: 0, question: '', currency: 'PEN', category: 'comida', ...p,
});
const fakeAi = (...list: Partial<Reading>[]) => {
  const p: Provider = { name: 'fake', vision: true, complete: async () => JSON.stringify(reading(list.shift() ?? {})) };
  return new Ai([p]);
};

describe('ahorro', () => {
  test('no deja retirar más de lo apartado', () => {
    const s = configured();
    expect(say(s, 'retiro ahorro 50')).toBe('No tienes ahorro apartado para retirar.');
    say(s, 'ahorro 30');
    expect(say(s, 'retiro ahorro 50')).toContain('Solo tienes S/ 30 de ahorro apartado');
    expect(snapshot(s.ledger(), DAY).savedTotal).toBe(3_000);
    expect(say(s, 'retiro ahorro 30')).toContain('Devolviste S/ 30');
  });
});

describe('deshacer', () => {
  test('no borra el saldo ni la deuda iniciales', () => {
    const s = configured();
    expect(say(s, 'deshacer')).toBe('No hay nada que deshacer.');
    expect(snapshot(s.ledger(), DAY).saldo).toBe(100_000);
    expect(snapshot(s.ledger(), DAY).cards[0]!.debt).toBe(10_000);
  });

  test('borra lo último que anotaste aunque después crees una tarjeta con deuda', () => {
    const s = configured();
    say(s, '25 almuerzo', 'tarjeta visa linea 2000 cierre 10 pago 25 deuda 300');
    expect(say(s, 'deshacer')).toContain('Borré: 04/11 almuerzo');
    expect(snapshot(s.ledger(), DAY).cards.find((c) => c.card.name === 'visa')!.debt).toBe(30_000);
  });
});

describe('pago de tarjeta con fecha', () => {
  test('la IA puede anotar un pago de ayer', async () => {
    const s = configured();
    const reply = await respond(s, fakeAi({ action: 'card_payment', amount: 50, card: 'cmr', days_ago: 1 }), 'ayer pagué 50 de la cmr', DAY, MS);
    expect(reply).toContain('Pago anotado: S/ 50 a CMR. Con fecha 03/11.');
    expect(s.ledger().txns.at(-1)!.day).toBe('2026-11-03');
  });

  test('sin fecha el comando no la incluye', () => {
    expect(toCommand(reading({ action: 'card_payment', amount: 50, card: 'cmr' }), new Map([['cmr', 1]]), DAY))
      .toEqual({ type: 'pay', cardId: 1, amount: 5_000 });
  });
});

describe('capturas repetidas', () => {
  const update = (id: number) => ({ update_id: id, message: { chat: { id: 7 }, from: { id: 7 }, photo: [{ file_id: 'p' }] } });

  function bot(bytes: () => string) {
    const sent: string[] = [];
    const tg = { send: async (_: number, t: string) => { sent.push(t); }, download: async () => new Blob([bytes()]) } as any;
    const s = configured();
    const access = new Access(7, s, mkdtempSync(join(tmpdir(), 'suave-')), { memory: true });
    return { s, sent, bot: new Bot(tg, access, fakeAi({}, {}, {})) };
  }

  test('la misma imagen no se anota dos veces', async () => {
    const { s, sent, bot: b } = bot(() => 'captura-1');
    const before = s.ledger().txns.length;
    await b.onUpdate(update(1), MS);
    await b.onUpdate(update(2), MS);
    expect(sent[0]).toContain('Anotado');
    expect(sent[1]).toContain('ya la anoté');
    expect(s.ledger().txns).toHaveLength(before + 1);
  });

  test('otra imagen sí se anota', async () => {
    let n = 0;
    const { s, bot: b } = bot(() => `captura-${n++}`);
    const before = s.ledger().txns.length;
    await b.onUpdate(update(1), MS);
    await b.onUpdate(update(2), MS);
    expect(s.ledger().txns).toHaveLength(before + 2);
  });
});

describe('dólares', () => {
  test('los atajos reconocen $, usd y dolares', () => {
    const aliases = new Map([['cmr', 1]]);
    expect(parse('$15 netflix cmr', aliases)).toMatchObject({ type: 'expense', amount: 1_500, description: 'netflix', cardId: 1, currency: 'USD' });
    expect(parse('15 usd spotify', aliases)).toMatchObject({ amount: 1_500, description: 'spotify', currency: 'USD' });
    expect(parse('uber 12.50 dolares', aliases)).toMatchObject({ amount: 1_250, description: 'uber', currency: 'USD' });
    expect(parse('puedo $40 zapatillas', aliases)).toMatchObject({ type: 'ask', amount: 4_000, currency: 'USD' });
    expect(parse('25 almuerzo', aliases)).not.toHaveProperty('currency');
  });

  test('dolar 3.75 fija el tipo de cambio, y un valor absurdo no', () => {
    expect(parse('dolar 3.75', new Map())).toEqual({ type: 'set_rate', rate: 3.75 });
    expect(parse('dolar 375', new Map()).type).not.toBe('set_rate');
  });

  test('sin tipo de cambio no anota nada', () => {
    const s = configured();
    const n = s.ledger().txns.length;
    expect(say(s, '$15 netflix')).toContain('Aún no tengo el tipo de cambio');
    expect(s.ledger().txns).toHaveLength(n);
  });

  test('convierte a soles y guarda el monto original', () => {
    const s = configured();
    say(s, 'dolar 3.75');
    expect(say(s, '$15.99 netflix cmr')).toContain('Anotado: netflix, US$ 15.99 (S/ 59.96 a 3.750) con CMR.');
    const t = s.ledger().txns.at(-1)!;
    expect(t).toMatchObject({ kind: 'purchase', amount: 5_996, currency: 'USD', original: 1_599, category: 'suscripciones' });
    expect(say(s, 'ultimos').split('\n')[0]).toBe('04/11 netflix (CMR): US$ 15.99 (S/ 59.96)');
  });

  test('la IA también puede anotar en dólares', async () => {
    const s = configured();
    s.setUsdRate(3.8, DAY);
    await respond(s, fakeAi({ amount: 10, currency: 'USD', description: 'steam', category: 'compras' }), 'gasté 10 dólares en steam', DAY, MS);
    expect(s.ledger().txns.at(-1)).toMatchObject({ amount: 3_800, original: 1_000, currency: 'USD', category: 'compras' });
  });

  test('el tipo de cambio se pide una vez al día y descarta valores absurdos', async () => {
    const s = new Store();
    let calls = 0;
    const source = async () => { calls++; return 3.71; };
    expect(await refreshRate([s], source, MS)).toBe(true);
    expect(await refreshRate([s], source, MS)).toBe(false);
    expect(calls).toBe(1);
    expect(s.usdRate).toBe(3.71);
    expect(await refreshRate([s], async () => 371, at('2026-11-05', 9))).toBe(false);
    expect(await refreshRate([s], async () => { throw new Error('caída'); }, at('2026-11-05', 9))).toBe(false);
    expect(s.usdRate).toBe(3.71);
  });

  test('el bot actualiza el tipo de cambio en sus avisos', async () => {
    const s = configured();
    const tg = { send: async () => {}, sendDocument: async () => {} } as any;
    const b = new Bot(tg, new Access(7, s, mkdtempSync(join(tmpdir(), 'suave-')), { memory: true }), null, async () => 3.69);
    await b.tick(MS);
    expect(s.usdRate).toBe(3.69);
    expect(s.usdRateDay).toBe(DAY);
  });
});

describe('categorías', () => {
  test('se deducen por palabras clave', () => {
    expect(categorize('almuerzo')).toBe('comida');
    expect(categorize('taxi al trabajo')).toBe('transporte');
    expect(categorize('netflix')).toBe('suscripciones');
    expect(categorize('cosa rara')).toBe('otros');
  });

  test('#categoria la elige a mano', () => {
    const s = configured();
    say(s, '40 almuerzo #salidas');
    expect(s.ledger().txns.at(-1)).toMatchObject({ description: 'almuerzo', category: 'salidas' });
  });

  test('un #algo que no es categoría queda en la descripción', () => {
    expect(parse('40 regalo #mama', new Map())).toEqual({ type: 'expense', amount: 4_000, description: 'regalo #mama', cardId: null });
  });
});

describe('fijos', () => {
  test('pagar un fijo lo reconoce y no cuenta como gasto de la semana', () => {
    const s = configured();
    const before = snapshot(s.ledger(), DAY);
    const reply = say(s, '80 internet');
    expect(reply).toStartWith('Pagaste tu fijo internet: S/ 80.');
    const after = snapshot(s.ledger(), DAY);
    expect(after.spent).toBe(before.spent);
    // Noviembre queda pagado; el de diciembre recién empieza a apartarse después del 25.
    expect(after.fixedUpcoming.find((f) => f.name === 'internet')).toMatchObject({ date: '2026-12-25', reserve: 0 });
  });

  test('el libre aparta de a poco el fijo antes de su semana', () => {
    const s = configured();
    // internet vence el 25: aún no es de este ciclo, pero ya hay una parte apartada.
    const snap = snapshot(s.ledger(), DAY);
    const internet = snap.fixedUpcoming.find((f) => f.name === 'internet')!;
    expect(snap.fixedPending).toEqual([]);
    expect(internet.reserve).toBeGreaterThan(0);
    expect(internet.reserve).toBeLessThan(8_000);
    expect(say(s, 'como voy')).toContain(`Fijo internet (25/11): apartado S/ ${internet.reserve / 100}`);
  });

  test('dice cuánto bajó el libre si el fijo aún no estaba apartado del todo', () => {
    const s = configured();
    const internet = snapshot(s.ledger(), DAY).fixedUpcoming.find((f) => f.name === 'internet')!;
    expect(say(s, '80 internet')).toContain(`Tu libre bajó S/ ${(8_000 - internet.reserve) / 100}: faltaba apartar esa parte.`);
  });
});

describe('resumen mensual', () => {
  function withOctober() {
    const s = configured();
    handle(s, '100 almuerzo', '2026-10-10');
    handle(s, '50 taxi', '2026-10-12');
    handle(s, '200 cena', '2026-11-02');
    handle(s, '40 uber', '2026-11-03');
    handle(s, '80 internet', '2026-11-03');
    return s;
  }

  test('agrupa por categoría y deja fuera los fijos', () => {
    const r = monthReport(withOctober().ledger(), '2026-11');
    expect(r.spent).toBe(24_000);
    expect(r.byCategory).toEqual([['comida', 20_000], ['transporte', 4_000]]);
    expect(r.fixedPaid).toBe(8_000);
    expect(r.previousSpent).toBe(15_000);
  });

  test('mes y mes pasado responden con el resumen', () => {
    const s = withOctober();
    const now = say(s, 'mes');
    expect(now).toStartWith('En lo que va de noviembre gastaste S/ 240, sin contar fijos.');
    expect(now).toContain('comida: S/ 200 (83%)');
    expect(now).toContain('Fijos pagados: S/ 80');
    const prev = handle(s, 'mes pasado', '2026-12-02');
    expect(prev).toStartWith('En noviembre gastaste S/ 240');
    expect(prev).toContain('Gastaste S/ 90 más que en octubre (+60%).');
  });

  test('el primer día del mes llega el resumen del anterior, una sola vez', () => {
    const s = withOctober();
    const n = dueNotices(s, at('2026-12-01', 9)).find((x) => x.flag === 'month:2026-11')!;
    expect(n.text).toStartWith('Cerró noviembre. En noviembre gastaste S/ 240');
    s.setFlag(n.flag);
    expect(dueNotices(s, at('2026-12-01', 10)).map((x) => x.flag)).not.toContain('month:2026-11');
    expect(dueNotices(s, at('2026-12-01', 8)).map((x) => x.flag)).not.toContain('month:2026-11');
  });
});

describe('migración de una base existente', () => {
  test('agrega columnas, marca lo inicial y categoriza lo anterior', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'suave-')), 'vieja.db');
    const old = new Database(path);
    old.exec(`
      CREATE TABLE txns (id INTEGER PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
        description TEXT NOT NULL DEFAULT '', card_id INTEGER, fixed_id INTEGER, income_id INTEGER);
      INSERT INTO txns (day, kind, amount, description) VALUES ('2026-10-01', 'adjust', 100000, 'saldo inicial');
      INSERT INTO txns (day, kind, amount, description) VALUES ('2026-10-02', 'expense', 2500, 'almuerzo');
    `);
    old.close();

    const s = new Store(path);
    const [initial, lunch] = s.ledger().txns;
    expect(initial).toMatchObject({ auto: true, currency: 'PEN', category: '' });
    expect(lunch).toMatchObject({ auto: false, category: 'comida', original: null });
    expect(new Store(path).ledger().txns).toHaveLength(2); // abrirla de nuevo no repite la migración
  });
});
