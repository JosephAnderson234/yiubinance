// Lee y valida el entorno una sola vez.
import { dirname, join } from 'node:path';

export interface Config {
  token: string;
  ownerId: number;
  telegramApi?: string;
  dbPath: string;
  backupPath: string;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const token = env.TELEGRAM_TOKEN;
  const ownerId = Number(env.OWNER_ID);
  if (!token || !Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error('Faltan TELEGRAM_TOKEN u OWNER_ID en el entorno.');
  }
  const dbPath = env.DB_PATH ?? './suave.db';
  return { token, ownerId, telegramApi: env.TELEGRAM_API, dbPath, backupPath: join(dirname(dbPath), 'backup.tmp.db') };
}
