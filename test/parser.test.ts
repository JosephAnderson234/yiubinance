import { describe, expect, test } from 'bun:test';
import { fmt, parseAmount } from '../src/money';
import { parse } from '../src/parser';

const aliases = new Map([['cmr', 1], ['bbva credito', 2], ['credito bbva', 2]]);
const p = (s: string) => parse(s, aliases);

describe('montos', () => {
  test.each([
    ['25', 2500], ['25.50', 2550], ['25,50', 2550], ['1,200', 120000], ['S/ 30', 3000], ['s/.30', 3000], ['0.10', 10],
  ])('%s', (raw, cents) => expect(parseAmount(raw)).toBe(cents));
  test('rechaza texto', () => expect(parseAmount('abc')).toBeNull());
  test('formato', () => {
    expect(fmt(2550)).toBe('S/ 25.50');
    expect(fmt(120000)).toBe('S/ 1,200');
    expect(fmt(-500)).toBe('-S/ 5');
  });
});

describe('gastos', () => {
  test('monto primero', () => expect(p('25 almuerzo')).toEqual({ type: 'expense', amount: 2500, description: 'almuerzo', cardId: null }));
  test('monto al final', () => expect(p('almuerzo 25')).toEqual({ type: 'expense', amount: 2500, description: 'almuerzo', cardId: null }));
  test('con S/', () => expect(p('S/ 25 menú')).toEqual({ type: 'expense', amount: 2500, description: 'menu', cardId: null }));
  test('con tarjeta CMR', () => expect(p('180 zapatillas cmr')).toEqual({ type: 'expense', amount: 18000, description: 'zapatillas', cardId: 1 }));
  test('con tarjeta BBVA', () => expect(p('90 cena bbva credito')).toEqual({ type: 'expense', amount: 9000, description: 'cena', cardId: 2 }));
  test('el banco solo no es la tarjeta', () => expect(p('25 almuerzo bbva')).toEqual({ type: 'expense', amount: 2500, description: 'almuerzo bbva', cardId: null }));
  test('una palabra que termina en cmr no es la tarjeta', () => expect(p('30 envio')).toMatchObject({ cardId: null, description: 'envio' }));
  test('solo el monto', () => expect(p('25')).toMatchObject({ amount: 2500, description: 'gasto' }));
  test('sin monto no anota', () => expect(p('hola que tal')).toEqual({ type: 'unknown' }));
  test('monto cero no anota', () => expect(p('0 nada')).toEqual({ type: 'unknown' }));
});

describe('otros comandos', () => {
  test('ingreso', () => expect(p('+350 quincena')).toEqual({ type: 'income', amount: 35000, description: 'quincena' }));
  test('ingreso sin nombre', () => expect(p('+400')).toEqual({ type: 'income', amount: 40000, description: '' }));
  test('pago parcial', () => expect(p('pago cmr 300')).toEqual({ type: 'pay', cardId: 1, amount: 30000 }));
  test('pago total', () => expect(p('pago bbva credito')).toEqual({ type: 'pay', cardId: 2, amount: null }));
  test('pago de otra cosa es gasto', () => expect(p('pago luz 80')).toMatchObject({ type: 'expense', amount: 8000, description: 'pago luz' }));
  test('pregunta', () => expect(p('¿puedo 120 cena?')).toEqual({ type: 'ask', amount: 12000, description: 'cena', cardId: null }));
  test('pregunta con tarjeta', () => expect(p('puedo gastar 120 en cena cmr')).toEqual({ type: 'ask', amount: 12000, description: 'cena', cardId: 1 }));
  test('saldo con monto', () => expect(p('saldo 820')).toEqual({ type: 'balance', amount: 82000 }));
  test('saldo solo', () => expect(p('saldo')).toEqual({ type: 'status' }));
  test('como voy', () => expect(p('¿Cómo voy?')).toEqual({ type: 'status' }));
  test('ahorro', () => expect(p('ahorro 50')).toEqual({ type: 'saving', amount: 5000 }));
  test('retiro de ahorro', () => expect(p('retiro ahorro 50')).toEqual({ type: 'saving', amount: -5000 }));
  test('fijo', () => expect(p('fijo internet 80 dia 15')).toEqual({ type: 'set_fixed', name: 'internet', amount: 8000, day: 15 }));
  test('ingreso semanal', () => expect(p('ingreso semana 400 domingo')).toEqual({ type: 'set_income', name: 'semana', amount: 40000, weekday: 0, days: [] }));
  test('ingreso quincenal', () => expect(p('ingreso quincena 350 dias 15,30')).toEqual({ type: 'set_income', name: 'quincena', amount: 35000, weekday: null, days: [15, 30] }));
  test('tarjeta', () => expect(p('tarjeta bbva credito linea 3000 cierre 20 pago 5')).toEqual({ type: 'set_card', name: 'bbva credito', limit: 300000, closeDay: 20, dueDay: 5, debt: 0 }));
  test('borrar', () => expect(p('borrar fijo internet')).toEqual({ type: 'remove', what: 'fijo', name: 'internet' }));
  test('deshacer', () => expect(p('borrar')).toEqual({ type: 'undo' }));
});
