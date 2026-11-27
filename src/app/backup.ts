// Copia diaria fuera del VPS: llega como archivo silencioso a tu chat, solo si hubo cambios.
import { rmSync } from 'node:fs';
import type { Store } from '../adapters/store';
import { localDay, localHour } from '../domain/dates';

const BACKUP_HOUR = 3;

export type SendFile = (path: string, filename: string) => Promise<void>;

export async function backupIfDue(store: Store, tmpPath: string, send: SendFile, ms: number) {
  const day = localDay(ms);
  const flag = `backup:${day}` as const;
  if (localHour(ms) < BACKUP_HOUR || store.hasFlag(flag) || !store.dirty) return;
  rmSync(tmpPath, { force: true });
  store.backupTo(tmpPath);
  try {
    await send(tmpPath, `suave-${day}.db`);
    store.setFlag(flag);
    store.dirty = false;
  } finally {
    rmSync(tmpPath, { force: true });
  }
}
