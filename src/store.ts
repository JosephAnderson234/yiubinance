import { Database } from 'bun:sqlite';
import type { Day } from './dates';
import type { Card, Fixed, Income, Ledger, Txn, TxnKind } from './engine';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, aliases TEXT NOT NULL, limit_cents INTEGER NOT NULL,
  close_day INTEGER NOT NULL, due_day INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS fixed (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount INTEGER NOT NULL, day INTEGER NOT NULL,
  since TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS incomes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
  weekday INTEGER, days TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS txns (
  id INTEGER PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '', card_id INTEGER, fixed_id INTEGER, income_id INTEGER);
`;

export type NewTxn = {
  day: Day;
  kind: TxnKind;
  amount: number;
  description?: string;
  cardId?: number | null;
  fixedId?: number | null;
  incomeId?: number | null;
};

export class Store {
  readonly db: Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  get(key: string): string | null {
    const row = this.db.query('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  set(key: string, value: string) {
    this.db.query('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  ledger(): Ledger {
    const txns = this.db.query('SELECT * FROM txns ORDER BY id').all().map((r: any): Txn => ({
      id: r.id, day: r.day, kind: r.kind, amount: r.amount, description: r.description,
      cardId: r.card_id, fixedId: r.fixed_id, incomeId: r.income_id,
    }));
    const cards = this.db.query('SELECT * FROM cards WHERE active = 1 ORDER BY id').all().map((r: any): Card => ({
      id: r.id, name: r.name, aliases: r.aliases.split('|'), limit: r.limit_cents, closeDay: r.close_day, dueDay: r.due_day,
    }));
    const fixed = this.db.query('SELECT * FROM fixed WHERE active = 1 ORDER BY id').all().map((r: any): Fixed => ({
      id: r.id, name: r.name, amount: r.amount, day: r.day, since: r.since,
    }));
    const incomes = this.db.query('SELECT * FROM incomes WHERE active = 1 ORDER BY id').all().map((r: any): Income => ({
      id: r.id, name: r.name, kind: r.kind, amount: r.amount, weekday: r.weekday,
      days: r.days ? r.days.split(',').map(Number) : [],
    }));
    return { txns, cards, fixed, incomes, savingGoal: Number(this.get('saving_goal') ?? 0) };
  }

  addTxn(t: NewTxn) {
    this.db
      .query('INSERT INTO txns (day, kind, amount, description, card_id, fixed_id, income_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.day, t.kind, t.amount, t.description ?? '', t.cardId ?? null, t.fixedId ?? null, t.incomeId ?? null);
  }

  deleteTxn(id: number) {
    this.db.query('DELETE FROM txns WHERE id = ?').run(id);
  }

  upsertCard(c: { name: string; aliases: string[]; limit: number; closeDay: number; dueDay: number }): number {
    const found = this.db.query('SELECT id FROM cards WHERE name = ? AND active = 1').get(c.name) as { id: number } | null;
    if (found) {
      this.db.query('UPDATE cards SET aliases = ?, limit_cents = ?, close_day = ?, due_day = ? WHERE id = ?')
        .run(c.aliases.join('|'), c.limit, c.closeDay, c.dueDay, found.id);
      return found.id;
    }
    const res = this.db.query('INSERT INTO cards (name, aliases, limit_cents, close_day, due_day) VALUES (?, ?, ?, ?, ?)')
      .run(c.name, c.aliases.join('|'), c.limit, c.closeDay, c.dueDay);
    return Number(res.lastInsertRowid);
  }

  upsertFixed(f: { name: string; amount: number; day: number; since: Day }) {
    const found = this.db.query('SELECT id FROM fixed WHERE name = ? AND active = 1').get(f.name) as { id: number } | null;
    if (found) this.db.query('UPDATE fixed SET amount = ?, day = ? WHERE id = ?').run(f.amount, f.day, found.id);
    else this.db.query('INSERT INTO fixed (name, amount, day, since) VALUES (?, ?, ?, ?)').run(f.name, f.amount, f.day, f.since);
  }

  upsertIncome(i: { name: string; amount: number; weekday: number | null; days: number[] }) {
    const kind = i.weekday === null ? 'monthly' : 'weekly';
    const days = i.days.join(',');
    const found = this.db.query('SELECT id FROM incomes WHERE name = ? AND active = 1').get(i.name) as { id: number } | null;
    if (found) {
      this.db.query('UPDATE incomes SET kind = ?, amount = ?, weekday = ?, days = ? WHERE id = ?').run(kind, i.amount, i.weekday, days, found.id);
    } else {
      this.db.query('INSERT INTO incomes (name, kind, amount, weekday, days) VALUES (?, ?, ?, ?, ?)').run(i.name, kind, i.amount, i.weekday, days);
    }
  }

  deactivate(table: 'cards' | 'fixed' | 'incomes', id: number) {
    this.db.query(`UPDATE ${table} SET active = 0 WHERE id = ?`).run(id);
  }

  /** Copia consistente de la base de datos, para el backup. */
  backupTo(path: string) {
    this.db.query('VACUUM INTO ?').run(path);
  }
}
