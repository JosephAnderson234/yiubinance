import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Servidor falso: ningún test debe salir a internet.
const requests: { path: string; auth: string | null; body: any }[] = [];
let groqStatus = (_model: string) => 200;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/botT/getFile') return Response.json({ ok: true, result: { file_path: 'voice/a.oga' } });
    if (path === '/file/botT/voice/a.oga') return new Response('audio');
    if (path.endsWith('/audio/transcriptions')) {
      const form = await req.formData();
      requests.push({ path, auth: req.headers.get('authorization'), body: Object.fromEntries(form) });
      return Response.json({ text: ' gasté 15 en un menú ' });
    }
    const body = (await req.json()) as any;
    requests.push({ path, auth: req.headers.get('authorization') ?? req.headers.get('x-api-key'), body });
    if (path.endsWith('/v1/messages')) {
      return Response.json({
        id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify(reading({ amount: 9 })) }],
      });
    }
    const status = groqStatus(body.model);
    if (status !== 200) return new Response('{}', { status });
    return Response.json({ choices: [{ message: { content: JSON.stringify(reading({ amount: 7 })) } }] });
  },
});
afterAll(() => { server.stop(true); });
process.env.GROQ_API = `http://127.0.0.1:${server.port}/openai/v1`;

const { Ai, AiUnavailable, claudeProvider, createAi, groqProvider, toCommand } = await import('../src/ai');
const { looksNatural, respond, respondToImage } = await import('../src/assistant');
const { Bot } = await import('../src/bot');
const { snapshot } = await import('../src/engine');
const { handle } = await import('../src/handlers');
const { Store } = await import('../src/store');
const { Telegram } = await import('../src/telegram');
type Reading = import('../src/ai').Reading;
type Provider = import('../src/ai').Provider;

function reading(p: Partial<Reading> = {}): Reading {
  return { action: 'expense', amount: 15, description: 'menu', card: '', days_ago: 0, question: '', ...p };
}

const DAY = '2026-11-04';
const MS = Date.parse('2026-11-04T12:00:00-05:00');
const aliases = new Map([['cmr', 1], ['bbva credito', 2]]);

const provider = (name: string, fn: Provider['complete'], vision = true): Provider => ({ name, vision, complete: fn });
const answers = (...list: Partial<Reading>[]) => {
  const seen: string[] = [];
  const ai = new Ai([provider('fake', async ({ text }) => {
    seen.push(text);
    return JSON.stringify(reading(list.shift() ?? {}));
  })], 'clave');
  return { ai, seen };
};

function configured() {
  const s = new Store();
  for (const m of ['/start', '1000', 'cmr 500 0 20 5', 'bbva credito 3000 0 15 5', 'listo', '400 domingo', '350 15,30', 'listo', '0']) handle(s, m, DAY);
  return s;
}

describe('cadena de proveedores', () => {
  const ok = (amount: number) => async () => JSON.stringify(reading({ amount }));
  const fail = (msg: string) => async () => { throw new Error(msg); };

  test('usa el primero si responde', async () => {
    expect((await new Ai([provider('a', ok(1)), provider('b', ok(2))]).read({ text: 'x' })).amount).toBe(1);
  });

  test('un 404 pasa al siguiente', async () => {
    expect((await new Ai([provider('a', fail('HTTP 404')), provider('b', ok(2))]).read({ text: 'x' })).amount).toBe(2);
  });

  test('un JSON roto o sin el formato pasa al siguiente', async () => {
    const bad = provider('a', async () => 'no es json');
    const wrong = provider('b', async () => '{"action":"robar"}');
    expect((await new Ai([bad, wrong, provider('c', ok(3))]).read({ text: 'x' })).amount).toBe(3);
  });

  test('si todos fallan, avisa', async () => {
    await expect(new Ai([provider('a', fail('HTTP 500'))]).read({ text: 'x' })).rejects.toBeInstanceOf(AiUnavailable);
  });

  test('una imagen salta a los modelos sin visión', async () => {
    const ai = new Ai([provider('texto', ok(1), false), provider('vision', ok(2), true)]);
    expect((await ai.read({ text: 'x', image: { base64: 'a', mime: 'image/jpeg' } })).amount).toBe(2);
  });

  test('sin claves no hay IA', async () => {
    expect(await createAi({})).toBeNull();
  });
});

describe('proveedores reales contra un servidor falso', () => {
  beforeEach(() => { requests.length = 0; groqStatus = () => 200; });

  test('Groq pide JSON estricto y sin razonamiento', async () => {
    const p = groqProvider('k', 'qwen/qwen3.8-27b', true, { reasoning_effort: 'none' });
    await p.complete({ text: 'hola', image: { base64: 'QQ==', mime: 'image/jpeg' } });
    const { auth, body } = requests[0]!;
    expect(auth).toBe('Bearer k');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.reasoning_effort).toBe('none');
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,QQ==');
  });

  test('si Groq da 404 en el primer modelo usa el segundo', async () => {
    groqStatus = (m) => (m.startsWith('qwen') ? 404 : 200);
    const ai = (await createAi({ GROQ_API_KEY: 'k' }))!;
    expect((await ai.read({ text: 'x' })).amount).toBe(7);
    expect(requests.map((r) => r.body.model)).toEqual(['qwen/qwen3.8-27b', 'openai/gpt-oss-120b']);
  });

  test('Claude usa el SDK con salida estructurada y fallback', async () => {
    const p = await claudeProvider('k', 'claude-opus-5-5', `http://127.0.0.1:${server.port}`);
    expect(JSON.parse(await p.complete({ text: 'hola' })).amount).toBe(9);
    const { body } = requests[0]!;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.format.type).toBe('json_schema');
  });

  test('Whisper recibe el audio en español', async () => {
    const text = await new Ai([], 'k').transcribe(new Blob(['ogg']));
    expect(text).toBe('gasté 15 en un menú');
    expect(requests[0]!.body.language).toBe('es');
  });
});

describe('validación de lo que dice la IA', () => {
  test('gasto de ayer con tarjeta', () => {
    expect(toCommand(reading({ amount: 80, card: 'CMR', days_ago: 1 }), aliases, DAY))
      .toEqual({ type: 'expense', amount: 8000, description: 'menu', cardId: 1, day: '2026-11-03' });
  });
  test('Yape no es una tarjeta', () => {
    expect(toCommand(reading({ card: 'yape' }), aliases, DAY)).toMatchObject({ type: 'expense', cardId: null });
  });
  test('una tarjeta inventada pide aclarar', () => {
    expect(toCommand(reading({ card: 'visa oro' }), aliases, DAY).type).toBe('clarify');
  });
  test('sin monto pregunta', () => {
    expect(toCommand(reading({ amount: 0 }), aliases, DAY)).toEqual({ type: 'clarify', question: '¿Cuánto fue?' });
  });
  test('un monto absurdo no se anota', () => {
    expect(toCommand(reading({ amount: 99_999_999 }), aliases, DAY).type).toBe('clarify');
  });
  test('un monto negativo en un gasto queda positivo', () => {
    expect(toCommand(reading({ amount: -20 }), aliases, DAY)).toMatchObject({ amount: 2000 });
  });
  test('días fuera de rango cuentan como hoy', () => {
    expect(toCommand(reading({ days_ago: 500 }), aliases, DAY)).toMatchObject({ day: DAY });
    expect(toCommand(reading({ days_ago: -3 }), aliases, DAY)).toMatchObject({ day: DAY });
  });
  test('pago total con monto cero', () => {
    expect(toCommand(reading({ action: 'card_payment', amount: 0, card: 'cmr' }), aliases, DAY))
      .toEqual({ type: 'pay', cardId: 1, amount: null });
  });
  test('una captura no puede borrar, pagar ni corregir', () => {
    for (const action of ['undo', 'balance', 'card_payment', 'saving', 'card_statement'] as const) {
      expect(toCommand(reading({ action, card: 'cmr' }), aliases, DAY, true).type).toBe('unknown');
    }
  });
  test('una captura sí puede ser un gasto', () => {
    expect(toCommand(reading(), aliases, DAY, true).type).toBe('expense');
  });
});

describe('cuándo usar IA', () => {
  test.each(['25 almuerzo', 'almuerzo 25', 's/ 25 menu', '180 zapatillas cmr'])('directo: %s', (t) => {
    expect(looksNatural(t)).toBe(false);
  });
  test.each(['gaste 25 en el almuerzo', 'taxi 15 ayer', '25 almuerzo ayer', 'pago luz 80', '25 con los patas en el bar del centro'])('IA: %s', (t) => {
    expect(looksNatural(t)).toBe(true);
  });
});

describe('conversación', () => {
  let s: InstanceType<typeof Store>;
  beforeEach(() => { s = configured(); });
  const saldo = () => snapshot(s.ledger(), DAY).saldo;

  test('los atajos no llaman a la IA', async () => {
    const { ai, seen } = answers();
    await respond(s, ai, '25 almuerzo', DAY, MS);
    await respond(s, ai, 'como voy', DAY, MS);
    expect(seen).toEqual([]);
    expect(saldo()).toBe(97_500);
  });

  test('una frase libre se anota con su fecha y tarjeta', async () => {
    const { ai, seen } = answers({ amount: 80, description: 'salida', card: 'cmr', days_ago: 1 });
    const r = await respond(s, ai, 'ayer salí con los patas y gasté como 80 en la cmr', DAY, MS);
    expect(r).toContain('Anotado: salida, S/ 80 con CMR. Con fecha 03/11.');
    expect(seen[0]).toContain('Tarjetas: cmr, bbva credito');
    expect(seen[0]).toContain('Hoy: 2026-11-04, miercoles');
  });

  test('si falta el monto pregunta y usa la respuesta', async () => {
    const { ai, seen } = answers({ action: 'clarify', amount: 0, question: '¿Cuánto fue el taxi?' }, { amount: 15, description: 'taxi' });
    expect(await respond(s, ai, 'tomé un taxi', DAY, MS)).toBe('¿Cuánto fue el taxi?');
    expect(saldo()).toBe(100_000);
    expect(await respond(s, ai, '15', DAY, MS + 1000)).toContain('Anotado: taxi, S/ 15.');
    expect(seen[1]).toContain('Mensaje anterior: tomé un taxi');
    expect(saldo()).toBe(98_500);
  });

  test('una aclaración vieja se olvida', async () => {
    const { ai, seen } = answers({ action: 'clarify', amount: 0, question: '¿Cuánto?' });
    await respond(s, ai, 'tomé un taxi', DAY, MS);
    await respond(s, ai, '15 taxi', DAY, MS + 11 * 60_000);
    expect(seen).toHaveLength(1);
    expect(saldo()).toBe(98_500);
  });

  test('sin IA, una frase con monto se anota y lo advierte', async () => {
    const ai = new Ai([provider('a', async () => { throw new Error('HTTP 503'); })]);
    const r = await respond(s, ai, 'taxi 15 ayer', DAY, MS);
    expect(saldo()).toBe(100_000);
    expect(r).toContain('Ahora no puedo interpretar');
    const r2 = await respond(s, ai, '15 taxi de ayer', DAY, MS);
    expect(r2).toContain('Sin IA por ahora');
    expect(saldo()).toBe(98_500);
  });

  test('sin IA, una frase sin monto no anota nada', async () => {
    const ai = new Ai([provider('a', async () => { throw new Error('HTTP 503'); })]);
    expect(await respond(s, ai, 'hola bot', DAY, MS)).toContain('no anoté nada');
    expect(saldo()).toBe(100_000);
  });

  test('nunca usa IA durante la configuración', async () => {
    const fresh = new Store();
    const { ai, seen } = answers();
    await respond(fresh, ai, '/start', DAY, MS);
    await respond(fresh, ai, '1000', DAY, MS);
    expect(seen).toEqual([]);
  });

  test('una captura de Yape se anota como gasto', async () => {
    const { ai } = answers({ amount: 25, description: 'juan p' });
    const r = await respondToImage(s, ai, { base64: 'a', mime: 'image/jpeg' }, '', DAY, MS);
    expect(r).toContain('Anotado: juan p, S/ 25.');
  });

  test('una captura maliciosa que pide borrar no hace nada', async () => {
    await respond(s, null, '25 almuerzo', DAY, MS);
    const { ai } = answers({ action: 'undo' });
    await respondToImage(s, ai, { base64: 'a', mime: 'image/jpeg' }, '', DAY, MS);
    expect(saldo()).toBe(97_500);
  });
});

describe('estado de cuenta', () => {
  let s: InstanceType<typeof Store>;
  beforeEach(() => { s = configured(); });
  const cmr = (day: string) => snapshot(s.ledger(), day).cards[0]!;

  test('corrige con compras de CMR que no se anotaron', () => {
    handle(s, '100 cena cmr', '2026-11-10');
    expect(handle(s, 'cuenta cmr 230', '2026-11-20')).toContain('Faltaban anotar S/ 130 de compras.');
    expect(cmr('2026-11-20').debt).toBe(23_000);
    expect(cmr('2026-11-20').billed).toBe(23_000);
  });

  test('las compras hechas después del cierre no entran en el estado', () => {
    handle(s, '100 cena cmr', '2026-11-10');
    handle(s, '50 taxi cmr', '2026-11-22');
    handle(s, 'cuenta cmr 100', '2026-11-23');
    expect(cmr('2026-11-23').debt).toBe(15_000);
    expect(cmr('2026-11-23').billed).toBe(10_000);
  });

  test('si cuadra no cambia nada', () => {
    handle(s, '100 cena cmr', '2026-11-10');
    const before = s.ledger().txns.length;
    expect(handle(s, 'cuenta cmr 100', '2026-11-20')).toContain('cuadra');
    expect(s.ledger().txns).toHaveLength(before);
  });

  test('deshacer revierte la corrección', () => {
    handle(s, 'cuenta cmr 230', '2026-11-20');
    handle(s, 'deshacer', '2026-11-20');
    expect(cmr('2026-11-20').debt).toBe(0);
  });
});

test('Telegram descarga un archivo en dos pasos', async () => {
  const blob = await new Telegram('T', `http://127.0.0.1:${server.port}`).download('x');
  expect(await blob.text()).toBe('audio');
});

describe('audios y fotos en el bot', () => {
  function fake(ai: InstanceType<typeof Ai> | null) {
    const sent: string[] = [];
    const tg = {
      send: async (_: number, t: string) => { sent.push(t); },
      download: async () => new Blob(['datos']),
    } as any;
    const s = configured();
    return { s, sent, bot: new Bot(s, tg, 7, join(mkdtempSync(join(tmpdir(), 'suave-')), 'b.db'), ai) };
  }
  const update = (message: object) => ({ update_id: 1, message: { chat: { id: 7 }, from: { id: 7 }, ...message } });

  test('un audio se transcribe y se anota', async () => {
    requests.length = 0;
    const ai = new Ai([provider('p', async () => JSON.stringify(reading()))], 'k');
    const { bot, sent } = fake(ai);
    await bot.onUpdate(update({ voice: { file_id: 'v', duration: 4 } }), MS);
    expect(sent[0]).toContain('Escuché: "gasté 15 en un menú"');
    expect(sent[0]).toContain('Anotado: menu, S/ 15.');
  });

  test('sin IA explica que falta activarla', async () => {
    const { bot, sent } = fake(null);
    await bot.onUpdate(update({ voice: { file_id: 'v', duration: 4 } }), MS);
    await bot.onUpdate(update({ photo: [{ file_id: 'p' }] }), MS);
    expect(sent[0]).toContain('me falta activar la IA');
    expect(sent[1]).toContain('me falta activar la IA');
  });

  test('un audio muy largo se rechaza sin descargarlo', async () => {
    const { bot, sent } = fake(new Ai([], 'k'));
    await bot.onUpdate(update({ voice: { file_id: 'v', duration: 300 } }), MS);
    expect(sent[0]).toContain('muy largo');
  });

  test('una foto usa la versión más grande', async () => {
    const seen: (string | undefined)[] = [];
    const ai = new Ai([provider('p', async ({ image }) => { seen.push(image?.base64); return JSON.stringify(reading()); })]);
    const { bot, sent } = fake(ai);
    await bot.onUpdate(update({ photo: [{ file_id: 'chica' }, { file_id: 'grande' }], caption: 'almuerzo' }), MS);
    expect(seen[0]).toBe(Buffer.from('datos').toString('base64'));
    expect(sent[0]).toContain('Anotado');
  });
});
