import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Access } from '../src/adapters/access';
import { Bot } from '../src/adapters/bot';
import { Store } from '../src/adapters/store';
import type { Buttons, Telegram } from '../src/adapters/telegram';
import { snapshot } from '../src/domain/snapshot';

const OWNER = 7;
const ANA = 100;
const LUIS = 200;
const DAY = '2026-11-04';
const MS = Date.parse('2026-11-04T12:00:00-05:00');

interface Sent { to: number; text: string; buttons?: Buttons }

function setup(opts: { memory?: boolean } = { memory: true }) {
  const sent: Sent[] = [];
  const edits: string[] = [];
  const answers: (string | undefined)[] = [];
  const docs: number[] = [];
  const tg = {
    send: async (to: number, text: string, buttons?: Buttons) => { sent.push({ to, text, buttons }); },
    answerCallback: async (_: string, text?: string) => { answers.push(text); },
    edit: async (_: number, __: number, text: string) => { edits.push(text); },
    sendDocument: async (to: number) => { docs.push(to); },
  } as unknown as Telegram;
  const dir = mkdtempSync(join(tmpdir(), 'suave-'));
  const owner = new Store();
  const access = new Access(OWNER, owner, dir, opts);
  const bot = new Bot(tg, access);
  let id = 1;
  const text = (from: number, t: string, chat = from) =>
    bot.onUpdate({ update_id: id++, message: { chat: { id: chat }, from: { id: from, first_name: from === ANA ? 'Ana' : 'Luis', username: 'user' }, text: t } }, MS);
  const tap = (from: number, data: string) =>
    bot.onUpdate({ update_id: id++, callback_query: { id: 'q', from: { id: from }, data, message: { message_id: 5, chat: { id: from } } } }, MS);
  const to = (who: number) => sent.filter((s) => s.to === who).map((s) => s.text);
  return { sent, edits, answers, docs, access, owner, bot, text, tap, to, dir };
}

const configure = async (text: (from: number, t: string) => Promise<void>, who: number, saldo: string) => {
  for (const m of [saldo, 'listo', '400 domingo', 'no', 'listo', '0']) await text(who, m);
};

describe('solicitud de acceso', () => {
  test('un desconocido pide acceso y al dueño le llegan los botones', async () => {
    const { sent, text, access } = setup();
    await text(ANA, 'hola');
    expect(sent[0]).toEqual({ to: ANA, text: expect.stringContaining('le pedí acceso al dueño'), buttons: undefined });
    expect(sent[1]!.to).toBe(OWNER);
    expect(sent[1]!.text).toContain('Ana (@user), ID 100');
    expect(sent[1]!.buttons).toEqual([['✅ Aprobar', 'access:approve:100'], ['❌ Rechazar', 'access:deny:100']]);
    expect(access.member(ANA)!.status).toBe('pending');
  });

  test('mientras espera no se anota nada y al dueño no le llegan avisos repetidos', async () => {
    const { text, to, access } = setup();
    await text(ANA, 'hola');
    await text(ANA, '25 almuerzo');
    expect(to(ANA)[1]).toContain('sigue pendiente');
    expect(to(OWNER)).toHaveLength(1);
    expect(access.storeFor(ANA).ledger().txns).toHaveLength(0);
  });

  test('solo el dueño puede aprobar', async () => {
    const { text, tap, answers, access } = setup();
    await text(ANA, 'hola');
    await tap(LUIS, 'access:approve:100');
    expect(answers).toEqual(['Solo el dueño puede aprobar solicitudes.']);
    expect(access.canUse(ANA)).toBe(false);
  });

  test('al aprobar, la persona recibe la bienvenida y empieza su configuración', async () => {
    const { text, tap, to, edits, access } = setup();
    await text(ANA, 'hola');
    await tap(OWNER, 'access:approve:100');
    expect(access.canUse(ANA)).toBe(true);
    expect(edits).toEqual(['Aprobado: Ana. Ya puede usar el bot.']);
    const welcome = to(ANA).at(-1)!;
    expect(welcome).toContain('ya tienes acceso');
    expect(welcome).toContain('se guardan en el servidor del dueño');
    expect(welcome).toContain('¿Cuánto tienes ahora');
  });

  test('un botón ya usado no cambia la decisión', async () => {
    const { text, tap, answers, access } = setup();
    await text(ANA, 'hola');
    await tap(OWNER, 'access:deny:100');
    await tap(OWNER, 'access:approve:100');
    expect(answers.at(-1)).toBe('Esa solicitud ya fue respondida.');
    expect(access.canUse(ANA)).toBe(false);
  });

  test('si se rechaza, se le avisa una vez y después se le ignora en silencio', async () => {
    const { text, tap, to } = setup();
    await text(ANA, 'hola');
    await tap(OWNER, 'access:deny:100');
    expect(to(ANA).at(-1)).toBe('El dueño no aprobó tu acceso a este bot.');
    const before = to(ANA).length;
    await text(ANA, 'porfa');
    expect(to(ANA)).toHaveLength(before);
    expect(to(OWNER)).toHaveLength(1);
  });

  test('en un grupo no responde ni pide acceso', async () => {
    const { text, sent, access } = setup();
    await text(ANA, 'hola', -999);
    expect(sent).toEqual([]);
    expect(access.member(ANA)).toBeNull();
  });
});

describe('cuentas separadas', () => {
  test('cada usuario tiene su propia plata', async () => {
    const { text, tap, owner, access } = setup();
    await text(OWNER, '/start');
    await configure(text, OWNER, '1000');
    await text(ANA, 'hola');
    await tap(OWNER, 'access:approve:100');
    await configure(text, ANA, '300');
    await text(ANA, '50 almuerzo');
    expect(snapshot(owner.ledger(), DAY).saldo).toBe(100_000);
    expect(snapshot(access.storeFor(ANA).ledger(), DAY).saldo).toBe(25_000);
  });

  test('la base de cada usuario es un archivo aparte, y la del dueño no se mueve', async () => {
    const { text, tap, dir, access } = setup({});
    await text(ANA, 'hola');
    await tap(OWNER, 'access:approve:100');
    expect(existsSync(join(dir, 'users', '100.db'))).toBe(true);
    expect(existsSync(join(dir, 'access.db'))).toBe(true);
    expect(access.storeFor(OWNER)).not.toBe(access.storeFor(ANA));
  });

  test('los avisos y el backup de cada uno van a su propio chat', async () => {
    const { text, tap, bot, docs } = setup();
    await text(OWNER, '/start');
    await configure(text, OWNER, '1000');
    await text(ANA, 'hola');
    await tap(OWNER, 'access:approve:100');
    await configure(text, ANA, '300');
    await bot.tick(Date.parse('2026-11-05T04:00:00-05:00'));
    expect(docs.sort()).toEqual([OWNER, ANA].sort());
  });
});

describe('comandos del dueño', () => {
  test('usuarios lista las solicitudes con su estado', async () => {
    const { text, tap, to } = setup();
    await text(ANA, 'hola');
    await text(LUIS, 'hola');
    await tap(OWNER, 'access:approve:100');
    await text(OWNER, 'usuarios');
    const list = to(OWNER).at(-1)!;
    expect(list).toContain('Ana (@user), ID 100: con acceso');
    expect(list).toContain('Luis (@user), ID 200: pendiente');
  });

  test('quitar deja sin acceso pero conserva sus datos, y aprobar lo devuelve', async () => {
    const { text, tap, to, access } = setup();
    await text(ANA, 'hola');
    await tap(OWNER, 'access:approve:100');
    await configure(text, ANA, '300');
    await text(OWNER, 'quitar 100');
    expect(to(OWNER).at(-1)).toContain('Le quité el acceso a Ana');
    expect(access.canUse(ANA)).toBe(false);

    const before = to(ANA).length;
    await text(ANA, '25 almuerzo');
    expect(to(ANA)).toHaveLength(before); // sin acceso: silencio

    await text(OWNER, 'aprobar 100');
    expect(to(OWNER).at(-1)).toBe('Le devolví el acceso a Ana.');
    expect(snapshot(access.storeFor(ANA).ledger(), DAY).saldo).toBe(30_000);
    expect(to(ANA)).toHaveLength(before); // no se le reinicia la configuración
  });

  test('un desconocido no puede usar los comandos del dueño', async () => {
    const { text, to, access } = setup();
    await text(ANA, 'hola');
    await text(ANA, 'aprobar 100');
    expect(access.canUse(ANA)).toBe(false);
    expect(to(ANA).at(-1)).toContain('sigue pendiente');
  });

  test('el offset vive en el registro y arranca desde el que tenía la base del dueño', () => {
    const owner = new Store();
    owner.offset = 500;
    const access = new Access(OWNER, owner, mkdtempSync(join(tmpdir(), 'suave-')), { memory: true });
    expect(access.offset).toBe(500);
    access.offset = 501;
    expect(access.offset).toBe(501);
  });
});
