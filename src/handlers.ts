// Recibe un mensaje de texto y devuelve la respuesta del bot.
import { prevMonthly, WEEKDAYS, type Day } from './dates';
import { debtOf, snapshot, type Ledger, type Txn } from './engine';
import { askReply, brief, cardLine, fullStatus, helpText } from './messages';
import { fmt, parseAmount } from './money';
import { normalize, parse, type Aliases, type Command } from './parser';
import type { Store } from './store';

const DONE = 'done';

export function aliasesOf(l: Ledger): Aliases {
  const map: Aliases = new Map();
  for (const c of l.cards) for (const a of c.aliases) map.set(a, c.id);
  return map;
}

const hasWord = (text: string, word: string) => ` ${normalize(text)} `.includes(` ${normalize(word)} `);

const displayName = (name: string) =>
  name.split(' ').map((w) => (w.length <= 3 ? w.toUpperCase() : w)).join(' ');

function saveCard(store: Store, today: Day, c: { name: string; limit: number; closeDay: number; dueDay: number; debt: number }) {
  const words = c.name.split(' ');
  const aliases = words.length === 2 ? [c.name, `${words[1]} ${words[0]}`] : [c.name];
  const shown = displayName(c.name);
  const id = store.upsertCard({ name: shown, aliases, limit: c.limit, closeDay: c.closeDay, dueDay: c.dueDay });
  const delta = c.debt - debtOf(store.ledger().txns, id);
  if (c.debt > 0 && delta !== 0) store.addTxn({ day: today, kind: 'debt_adjust', amount: delta, description: 'deuda inicial', cardId: id });
  return shown;
}

const PROMPTS: Record<string, string> = {
  saldo: '¿Cuánto tienes ahora en tu cuenta o Yape? Ejemplo: 820',
  tarjetas: 'Ahora tus tarjetas de crédito: nombre, línea, deuda actual, día en que sale la cuenta y último día de pago. Ejemplo: visa 1500 120 20 5. Puedes mandar varias, una por línea. Cuando termines, o si no tienes, escribe listo.',
  semana: '¿Cuánto te entra cada semana y qué día? Ejemplo: 400 domingo',
  quincena: '¿Cuánto es tu ingreso quincenal y qué días cae? Ejemplo: 350 15,30. Si no tienes, escribe no.',
  fijos: 'Ahora tus gastos fijos: nombre, monto y día del mes. Ejemplo: internet 80 15. Puedes mandar varios, uno por línea. Cuando termines, escribe listo.',
  ahorro: '¿Cuánto quieres apartar por semana? Ejemplo: 50. Si nada, escribe 0.',
};

function onboard(store: Store, step: string, text: string, today: Day): string {
  const t = normalize(text);
  const parts = t.split(' ');
  const retry = `No te entendí. ${PROMPTS[step]}`;
  const next = (s: string, prefix = '') => {
    store.set('step', s);
    return `${prefix}${PROMPTS[s]}`;
  };

  if (step === 'saldo') {
    const amount = parseAmount(t);
    if (amount === null) return retry;
    store.addTxn({ day: today, kind: 'adjust', amount, description: 'saldo inicial' });
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
    const names = parsed.map((c) => saveCard(store, today, { ...c, limit: c.limit!, debt: c.debt! }));
    return `Anotada${names.length > 1 ? 's' : ''}: ${names.join(', ')}. Manda otra o escribe listo.`;
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
    return `Anotado${parsed.length > 1 ? 's' : ''}: ${parsed.map((f) => f.name).join(', ')}. Manda otro o escribe listo.`;
  }
  if (step === 'ahorro') {
    const amount = parseAmount(t);
    if (amount === null) return retry;
    store.set('saving_goal', String(amount));
    store.set('step', DONE);
    return `Listo, ya estás configurado.\n\n${brief(snapshot(store.ledger(), today))}\n\nEscribe ayuda para ver los comandos.`;
  }
  return retry;
}

const isDay = (n: number) => Number.isInteger(n) && n >= 1 && n <= 31;

function describe(t: Txn, l: Ledger): string {
  const card = l.cards.find((c) => c.id === t.cardId)?.name;
  const label: Record<Txn['kind'], string> = {
    expense: t.description,
    income: `ingreso ${t.description}`.trim(),
    purchase: `${t.description} (${card ?? 'tarjeta'})`,
    payment: `pago ${card ?? 'tarjeta'}`,
    adjust: 'ajuste de saldo',
    debt_adjust: `${t.description} ${card ?? ''}`.trim(),
    saving: 'ahorro',
  };
  return `${t.day.slice(8)}/${t.day.slice(5, 7)} ${label[t.kind]}: ${fmt(t.amount)}`;
}

function settingsText(l: Ledger): string {
  const lines = ['Tarjetas:'];
  for (const c of l.cards) lines.push(`${c.name}: línea ${fmt(c.limit)}, sale el ${c.closeDay}, pago hasta el ${c.dueDay}`);
  lines.push('', 'Ingresos:');
  for (const i of l.incomes) {
    lines.push(`${i.name}: ${fmt(i.amount)}, ${i.kind === 'weekly' ? `cada ${WEEKDAYS[i.weekday!]}` : `días ${i.days.join(', ')}`}`);
  }
  lines.push('', 'Fijos:');
  for (const f of l.fixed) lines.push(`${f.name}: ${fmt(f.amount)}, día ${f.day}`);
  lines.push('', `Meta de ahorro semanal: ${fmt(l.savingGoal)}`);
  return lines.join('\n');
}

export function handle(store: Store, text: string, today: Day): string {
  const step = store.get('step');
  if (!step) {
    store.set('step', 'saldo');
    return `Hola, te configuro en unos pasos.\n\n${PROMPTS.saldo}`;
  }
  if (step !== DONE) return onboard(store, step, text, today);
  return execute(store, parse(text, aliasesOf(store.ledger())), today);
}

const dated = (day: Day, today: Day) => (day === today ? '' : ` Con fecha ${day.slice(8)}/${day.slice(5, 7)}.`);

export function execute(store: Store, cmd: Command, today: Day): string {
  const l = store.ledger();
  const after = () => snapshot(store.ledger(), today);
  const cardOf = (id: number) => after().cards.find((c) => c.card.id === id)!;

  switch (cmd.type) {
    case 'start':
    case 'help':
      return helpText(store.ledger().cards.map((c) => c.aliases[0]!));
    case 'status':
      return fullStatus(after());
    case 'settings':
      return settingsText(l);
    case 'recent': {
      const last = l.txns.slice(-8).reverse();
      return last.length ? last.map((t) => describe(t, l)).join('\n') : 'Aún no hay movimientos.';
    }
    case 'undo': {
      const last = l.txns[l.txns.length - 1];
      if (!last) return 'No hay nada que deshacer.';
      store.deleteTxn(last.id);
      return `Borré: ${describe(last, l)}\n\n${brief(after())}`;
    }
    case 'expense': {
      const fixed = l.fixed.find((f) => hasWord(cmd.description, f.name));
      const kind = cmd.cardId === null ? 'expense' : 'purchase';
      const day = cmd.day ?? today;
      store.addTxn({ day, kind, amount: cmd.amount, description: cmd.description, cardId: cmd.cardId, fixedId: fixed?.id });
      const when = dated(day, today);
      if (cmd.cardId === null) return `Anotado: ${cmd.description}, ${fmt(cmd.amount)}.${when}\n${brief(after())}`;
      const card = cardOf(cmd.cardId);
      return `Anotado: ${cmd.description}, ${fmt(cmd.amount)} con ${card.card.name}.${when}\n${cardLine(card)}\n${brief(after())}`;
    }
    case 'ask': {
      const fake: Txn = {
        id: -1, day: today, kind: cmd.cardId === null ? 'expense' : 'purchase', amount: cmd.amount,
        description: cmd.description, cardId: cmd.cardId, fixedId: null, incomeId: null,
      };
      return askReply(snapshot({ ...l, txns: [...l.txns, fake] }, today), cmd.amount);
    }
    case 'income': {
      const source =
        l.incomes.find((i) => cmd.description && hasWord(cmd.description, i.name)) ??
        (cmd.description ? undefined : l.incomes.find((i) => i.kind === 'weekly'));
      const before = snapshot(l, today).libre;
      store.addTxn({ day: cmd.day ?? today, kind: 'income', amount: cmd.amount, description: cmd.description || source?.name, incomeId: source?.id });
      const s = after();
      return `Ingreso anotado: ${fmt(cmd.amount)}. Tu libre subió ${fmt(s.libre - before)}.\n${brief(s)}`;
    }
    case 'pay': {
      const debt = debtOf(l.txns, cmd.cardId);
      const name = l.cards.find((c) => c.id === cmd.cardId)!.name;
      if (debt <= 0) return `No debes nada en ${name}.`;
      const amount = cmd.amount ?? debt;
      if (amount > debt) return `Solo debes ${fmt(debt)} en ${name}. Revisa el monto.`;
      store.addTxn({ day: today, kind: 'payment', amount, description: 'pago tarjeta', cardId: cmd.cardId });
      return `Pago anotado: ${fmt(amount)} a ${name}.\n${cardLine(cardOf(cmd.cardId))}\n${brief(after())}`;
    }
    case 'statement': {
      const card = l.cards.find((c) => c.id === cmd.cardId)!;
      const close = prevMonthly(today, card.closeDay);
      const noted = debtOf(l.txns, card.id, close);
      const diff = cmd.amount - noted;
      if (diff === 0) return `Tu cuenta ${card.name} cuadra con lo anotado: ${fmt(cmd.amount)}.\n${brief(after())}`;
      store.addTxn({ day: close, kind: 'debt_adjust', amount: diff, description: 'ajuste de cuenta', cardId: card.id });
      const note = diff > 0 ? `Faltaban anotar ${fmt(diff)} de compras.` : `Tenías anotados ${fmt(-diff)} de más.`;
      return `Cuenta ${card.name} corregida a ${fmt(cmd.amount)}. ${note}\n${brief(after())}`;
    }
    case 'balance': {
      const current = snapshot(l, today).saldo;
      const diff = cmd.amount - current;
      if (diff === 0) return `Cuadra exacto.\n${brief(after())}`;
      store.addTxn({ day: today, kind: 'adjust', amount: diff, description: 'ajuste de saldo' });
      const note = diff < 0 ? `Faltaban anotar ${fmt(-diff)} de gastos.` : `Tenías ${fmt(diff)} más de lo anotado.`;
      return `Saldo corregido a ${fmt(cmd.amount)}. ${note}\n${brief(after())}`;
    }
    case 'saving': {
      store.addTxn({ day: today, kind: 'saving', amount: cmd.amount, description: 'ahorro' });
      const s = after();
      const did = cmd.amount > 0 ? `Apartaste ${fmt(cmd.amount)}` : `Devolviste ${fmt(-cmd.amount)}`;
      return `${did}. Ahorro total: ${fmt(s.savedTotal)}.\n${brief(s)}`;
    }
    case 'set_fixed':
      store.upsertFixed({ name: cmd.name, amount: cmd.amount, day: cmd.day, since: today });
      return `Fijo guardado: ${cmd.name}, ${fmt(cmd.amount)} el día ${cmd.day}.\n${brief(after())}`;
    case 'set_income':
      store.upsertIncome(cmd);
      return `Ingreso guardado: ${cmd.name}, ${fmt(cmd.amount)}.`;
    case 'set_card': {
      const name = saveCard(store, today, cmd);
      return `Tarjeta guardada: ${name}, línea ${fmt(cmd.limit)}.\n${brief(after())}`;
    }
    case 'set_goal':
      store.set('saving_goal', String(cmd.amount));
      return `Meta de ahorro: ${fmt(cmd.amount)} por semana.\n${brief(after())}`;
    case 'remove': {
      if (cmd.what === 'tarjeta') {
        const card = l.cards.find((c) => c.aliases.includes(cmd.name));
        if (!card) return `No encontré la tarjeta ${cmd.name}.`;
        if (debtOf(l.txns, card.id) > 0) return `No puedo borrar ${card.name} mientras tenga deuda.`;
        store.deactivate('cards', card.id);
        return `Tarjeta borrada: ${card.name}.`;
      }
      const list = cmd.what === 'fijo' ? l.fixed : l.incomes;
      const item = list.find((x) => x.name === cmd.name);
      if (!item) return `No encontré ${cmd.what} ${cmd.name}.`;
      store.deactivate(cmd.what === 'fijo' ? 'fixed' : 'incomes', item.id);
      return `Borrado: ${cmd.what} ${item.name}.`;
    }
    case 'unknown':
      return 'No te entendí, y no anoté nada. Prueba con: 25 almuerzo. Escribe ayuda para ver los comandos.';
  }
}
