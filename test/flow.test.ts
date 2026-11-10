import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../src/bot';
import { snapshot } from '../src/engine';
import { handle } from '../src/handlers';
import { dueNotices } from '../src/scheduler';
import { Store } from '../src/store';
import type { Telegram } from '../src/telegram';

const DAY = '2026-11-04'; // miércoles
const say = (s: Store, ...msgs: string[]) => msgs.map((m) => handle(s, m, DAY)).at(-1)!;
const at = (day: string, hour: number) => Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00-05:00`);

function configured() {
  const s = new Store();
  say(s, '/start', '1000', 'cmr 500 0 20 5\nbbva credito 3000 0 15 5', 'listo', '400 domingo', '350 15,30', 'internet 80 25\nluz 60 26', 'listo', '0');
  return s;
}

describe('configuración inicial', () => {
  test('deja todo guardado', () => {
    const s = configured();
    const l = s.ledger();
    expect(s.get('step')).toBe('done');
    expect(l.cards.map((c) => c.name)).toEqual(['CMR', 'bbva credito']);
    expect(l.cards[0]!.limit).toBe(50_000);
    expect(l.incomes.map((i) => i.name)).toEqual(['semana', 'quincena']);
    expect(l.fixed.map((f) => f.name)).toEqual(['internet', 'luz']);
    expect(snapshot(l, DAY).saldo).toBe(100_000);
  });

  test('una respuesta inválida repite la pregunta sin avanzar', () => {
    const s = new Store();
    say(s, '/start');
    expect(say(s, 'no sé')).toContain('No te entendí');
    expect(s.get('step')).toBe('saldo');
  });

  test('se puede empezar con una tarjeta y agregar otra después', () => {
    const s = new Store();
    say(s, '/start', '1000', 'cmr 500 0 20 5', 'listo', '400 domingo', 'no', 'listo', '0');
    expect(s.ledger().cards).toHaveLength(1);
    say(s, 'tarjeta bbva credito linea 3000 cierre 20 pago 5');
    expect(s.ledger().cards).toHaveLength(2);
    expect(say(s, '90 cena bbva credito')).toContain('con bbva credito');
  });
});

describe('uso diario', () => {
  let s: Store;
  beforeEach(() => { s = configured(); });
  const saldo = () => snapshot(s.ledger(), DAY).saldo;

  test('gasto baja el saldo y responde con el libre', () => {
    const r = say(s, '25 almuerzo');
    expect(r).toContain('Anotado: almuerzo, S/ 25.');
    expect(r).toContain('Libre:');
    expect(saldo()).toBe(97_500);
  });

  test('compra con CMR sube la deuda y avisa la línea restante', () => {
    const r = say(s, '180 zapatillas cmr');
    expect(r).toContain('CMR: debes S/ 180, te quedan S/ 320 de línea.');
    expect(saldo()).toBe(100_000);
  });

  test('pasarse de la línea de CMR pide depositar', () => {
    expect(say(s, '560 monitor cmr')).toContain('te pasaste S/ 60 de la línea de CMR');
  });

  test('pago total sin monto deja la deuda en cero', () => {
    say(s, '180 zapatillas cmr');
    expect(say(s, 'pago cmr')).toContain('Pago anotado: S/ 180 a CMR.');
    expect(saldo()).toBe(82_000);
    expect(say(s, 'pago cmr')).toBe('No debes nada en CMR.');
  });

  test('no deja pagar más de lo que debes', () => {
    say(s, '100 cena cmr');
    expect(say(s, 'pago cmr 300')).toContain('Solo debes S/ 100');
    expect(saldo()).toBe(100_000);
  });

  test('preguntar no registra nada', () => {
    const before = s.ledger().txns.length;
    expect(say(s, '¿puedo 120 cena?')).toContain('No anoté nada');
    expect(s.ledger().txns).toHaveLength(before);
  });

  test('preguntar por algo imposible dice que mejor no', () => {
    expect(say(s, 'puedo 5000 laptop')).toStartWith('Mejor no.');
  });

  test('un gasto que menciona un fijo lo marca pagado', () => {
    say(s, 'fijo gym 50 dia 6');
    expect(snapshot(s.ledger(), DAY).fixedPending.map((f) => f.name)).toContain('gym');
    say(s, '50 gym');
    expect(snapshot(s.ledger(), DAY).fixedPending.map((f) => f.name)).not.toContain('gym');
  });

  test('saldo corrige la diferencia y dice cuánto faltó anotar', () => {
    expect(say(s, 'saldo 900')).toContain('Faltaban anotar S/ 100 de gastos.');
    expect(saldo()).toBe(90_000);
  });

  test('deshacer borra lo último', () => {
    say(s, '25 almuerzo');
    expect(say(s, 'deshacer')).toContain('Borré:');
    expect(saldo()).toBe(100_000);
  });

  test('un ingreso con nombre se asocia a su fuente', () => {
    say(s, '+350 quincena');
    const l = s.ledger();
    expect(l.txns.at(-1)!.incomeId).toBe(l.incomes.find((i) => i.name === 'quincena')!.id);
  });

  test('un texto sin monto no anota nada', () => {
    const before = s.ledger().txns.length;
    expect(say(s, 'hola')).toContain('No te entendí');
    expect(s.ledger().txns).toHaveLength(before);
  });

  test('no borra una tarjeta con deuda', () => {
    say(s, '100 cena cmr');
    expect(say(s, 'borrar tarjeta cmr')).toContain('mientras tenga deuda');
  });
});

describe('avisos', () => {
  let s: Store;
  beforeEach(() => { s = configured(); });
  const flags = (ms: number) => dueNotices(s, ms).map((n) => n.flag.split(':')[0]);

  test('sin configurar no avisa nada', () => {
    expect(dueNotices(new Store(), at('2026-11-08', 21))).toEqual([]);
  });

  test('resumen del domingo en la noche pide el saldo, y no antes', () => {
    expect(flags(at('2026-11-08', 10))).not.toContain('summary');
    const n = dueNotices(s, at('2026-11-08', 20)).find((x) => x.flag.startsWith('summary'))!;
    expect(n.text).toContain('saldo 820');
  });

  test('un aviso ya enviado no se repite', () => {
    const ms = at('2026-11-08', 20);
    for (const n of dueNotices(s, ms)) s.set(n.flag, '1');
    expect(dueNotices(s, ms)).toEqual([]);
  });

  test('avisa cuando sale la cuenta con deuda', () => {
    handle(s, '100 cena cmr', '2026-11-10');
    const n = dueNotices(s, at('2026-11-20', 9)).find((x) => x.flag.startsWith('close'))!;
    expect(n.text).toContain('Salió tu cuenta CMR: S/ 100');
  });

  test('avisa el día de la cuenta aunque no tenga compras anotadas', () => {
    const n = dueNotices(s, at('2026-11-20', 9)).find((x) => x.flag.startsWith('close:1:'))!;
    expect(n.text).toContain('Hoy sale tu cuenta CMR');
    expect(n.text).toContain('cuenta cmr 230');
  });

  test('no avisa de la cuenta si ya la pagaste', () => {
    handle(s, '100 cena cmr', '2026-11-10');
    handle(s, 'pago cmr', '2026-11-20');
    expect(flags(at('2026-11-21', 9))).not.toContain('close');
    expect(flags(at('2026-12-03', 9))).not.toContain('due');
  });

  test('avisa 2 días antes del vencimiento si sigue impaga', () => {
    handle(s, '100 cena cmr', '2026-11-10');
    expect(flags(at('2026-12-03', 9))).toContain('due');
    expect(flags(at('2026-12-02', 9))).not.toContain('due');
  });

  test('la quincena atrasada 4 días pregunta, a los 3 todavía no', () => {
    expect(flags(at('2026-11-18', 9))).not.toContain('late');
    const n = dueNotices(s, at('2026-11-19', 9)).find((x) => x.flag.startsWith('late'))!;
    expect(n.text).toContain('¿Ya te cayó quincena?');
  });

  test('si la quincena ya llegó no pregunta', () => {
    handle(s, '+350 quincena', '2026-11-17');
    expect(flags(at('2026-11-19', 9))).not.toContain('late');
  });

  test('3 días sin registrar recuerda anotar', () => {
    expect(flags(at('2026-11-06', 20))).not.toContain('idle');
    expect(flags(at('2026-11-07', 20))).toContain('idle');
  });
});

describe('bot', () => {
  function fake() {
    const sent: string[] = [];
    const docs: string[] = [];
    const tg = {
      send: async (_: number, t: string) => { sent.push(t); },
      sendDocument: async (_: number, __: string, name: string) => { docs.push(name); },
    } as unknown as Telegram;
    const s = new Store();
    const bot = new Bot(s, tg, 7, join(mkdtempSync(join(tmpdir(), 'suave-')), 'b.db'));
    return { s, bot, sent, docs };
  }
  const msg = (update_id: number, from: number, text?: string) => ({
    update_id, message: { chat: { id: from }, from: { id: from }, text },
  });

  test('ignora a cualquiera que no sea el dueño', async () => {
    const { s, bot, sent } = fake();
    await bot.onUpdate(msg(1, 999, '/start'));
    expect(sent).toEqual([]);
    expect(s.get('step')).toBeNull();
  });

  test('guarda el offset para no reprocesar mensajes', async () => {
    const { s, bot } = fake();
    await bot.onUpdate(msg(41, 7, '/start'));
    expect(s.get('offset')).toBe('42');
  });

  test('responde al dueño y avisa si manda algo que no entiende', async () => {
    const { bot, sent } = fake();
    await bot.onUpdate(msg(1, 7, '/start'));
    await bot.onUpdate(msg(2, 7));
    expect(sent[0]).toContain('te configuro');
    expect(sent[1]).toContain('no lo entiendo todavía');
  });

  test('backup: uno por día y solo si hubo cambios', async () => {
    const { bot, docs } = fake();
    await bot.tick(at('2026-11-04', 4));
    expect(docs).toEqual([]);
    await bot.onUpdate(msg(1, 7, '/start'));
    await bot.tick(at('2026-11-04', 4));
    await bot.tick(at('2026-11-04', 5));
    expect(docs).toEqual(['suave-2026-11-04.db']);
  });
});
