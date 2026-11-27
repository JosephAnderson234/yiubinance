// Ejecuta un comando ya interpretado contra el libro y devuelve la respuesta.
import type { Store } from '../adapters/store';
import type { Command } from '../domain/command';
import { prevMonthly, type Day } from '../domain/dates';
import type { Txn } from '../domain/ledger';
import { fmt } from '../domain/money';
import { hasWord } from '../domain/normalize';
import { debtOf, snapshot } from '../domain/snapshot';
import { askReply, brief, cardLine, dated, describeTxn, fallback, fullStatus, helpText, settingsText } from '../replies/es';
import { saveCard } from './cards';

export function execute(store: Store, cmd: Command, today: Day): string {
  const l = store.ledger();
  const after = () => snapshot(store.ledger(), today);
  const cardOf = (id: number) => after().cards.find((c) => c.card.id === id)!;

  switch (cmd.type) {
    case 'start':
    case 'help':
      return helpText(l.cards.map((c) => c.aliases[0]!));
    case 'status':
      return fullStatus(after());
    case 'settings':
      return settingsText(l);
    case 'recent': {
      const last = l.txns.slice(-8).reverse();
      return last.length ? last.map((t) => describeTxn(t, l)).join('\n') : 'Aún no hay movimientos.';
    }
    case 'undo': {
      const last = l.txns[l.txns.length - 1];
      if (!last) return 'No hay nada que deshacer.';
      store.deleteTxn(last.id);
      return `Borré: ${describeTxn(last, l)}\n\n${brief(after())}`;
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
      store.savingGoal = cmd.amount;
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
      return fallback.unknownShortcut;
  }
}
