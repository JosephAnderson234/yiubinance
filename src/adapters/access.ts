// Quién puede usar el bot. Cada usuario aprobado tiene su propia base: sus datos nunca se mezclan con los de otro.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store';

export type Status = 'pending' | 'approved' | 'denied' | 'revoked';

export interface Member {
  id: number;
  name: string;
  username: string;
  status: Status;
  requestedAt: number;
  decidedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  requested_at INTEGER NOT NULL, decided_at INTEGER);
`;

export interface AccessOptions {
  /** Bases en memoria para los usuarios (tests). */
  memory?: boolean;
}

export class Access {
  private readonly db: Database;
  private readonly stores = new Map<number, Store>();

  /**
   * @param ownerStore la base del dueño: se mantiene donde ya estaba, sin migrar nada.
   * @param dir carpeta de datos: aquí van access.db, users/<id>.db y los temporales de backup.
   */
  constructor(
    readonly ownerId: number,
    private readonly ownerStore: Store,
    private readonly dir: string,
    private readonly opts: AccessOptions = {},
  ) {
    this.db = new Database(opts.memory ? ':memory:' : join(dir, 'access.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.stores.set(ownerId, ownerStore);
  }

  /** Próximo update_id que se pide a Telegram. Antes vivía en la base del dueño: se lee de ahí la primera vez. */
  get offset(): number {
    const row = this.db.query("SELECT value FROM meta WHERE key = 'offset'").get() as { value: string } | null;
    return row ? Number(row.value) : this.ownerStore.offset;
  }
  set offset(v: number) {
    this.db.query("INSERT INTO meta (key, value) VALUES ('offset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v));
  }

  isOwner(id: number) { return id === this.ownerId; }

  canUse(id: number) { return this.isOwner(id) || this.member(id)?.status === 'approved'; }

  member(id: number): Member | null {
    const r = this.db.query('SELECT * FROM members WHERE id = ?').get(id) as any;
    return r ? toMember(r) : null;
  }

  members(status?: Status): Member[] {
    const rows = status
      ? this.db.query('SELECT * FROM members WHERE status = ? ORDER BY requested_at').all(status)
      : this.db.query('SELECT * FROM members ORDER BY requested_at').all();
    return (rows as any[]).map(toMember);
  }

  request(id: number, name: string, username: string, ms: number) {
    this.db.query('INSERT INTO members (id, name, username, status, requested_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, username, 'pending', ms);
  }

  decide(id: number, status: Exclude<Status, 'pending'>, ms: number) {
    this.db.query('UPDATE members SET status = ?, decided_at = ? WHERE id = ?').run(status, ms, id);
  }

  /** El dueño y los aprobados: a quienes se les mandan avisos y backups. */
  activeIds(): number[] {
    return [this.ownerId, ...this.members('approved').map((m) => m.id)];
  }

  storeFor(id: number): Store {
    let s = this.stores.get(id);
    if (!s) {
      if (this.opts.memory) s = new Store();
      else {
        mkdirSync(join(this.dir, 'users'), { recursive: true });
        s = new Store(join(this.dir, 'users', `${id}.db`));
      }
      this.stores.set(id, s);
    }
    return s;
  }

  backupPathFor(id: number) {
    return join(this.dir, `backup-${id}.tmp.db`);
  }
}

const toMember = (r: any): Member => ({
  id: r.id, name: r.name, username: r.username, status: r.status, requestedAt: r.requested_at, decidedAt: r.decided_at,
});
