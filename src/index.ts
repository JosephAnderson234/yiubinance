import { dirname, join } from 'node:path';
import { createAi } from './ai';
import { Bot } from './bot';
import { Store } from './store';
import { Telegram } from './telegram';

const token = process.env.TELEGRAM_TOKEN;
const ownerId = Number(process.env.OWNER_ID);
if (!token || !Number.isInteger(ownerId) || ownerId <= 0) {
  console.error('Faltan TELEGRAM_TOKEN u OWNER_ID en el entorno.');
  process.exit(1);
}

const dbPath = process.env.DB_PATH ?? './suave.db';
const store = new Store(dbPath);
const tg = new Telegram(token, process.env.TELEGRAM_API);
const ai = await createAi(process.env);
const bot = new Bot(store, tg, ownerId, join(dirname(dbPath), 'backup.tmp.db'), ai);

const TICK_MS = 60_000;
const RETRY_MS = 5_000;

async function tick() {
  try {
    await bot.tick();
  } catch (err) {
    console.error('Error en avisos programados:', err);
  }
}

setInterval(tick, TICK_MS);
void tick();
console.log(`Bot en marcha. IA ${ai ? 'activa' : 'desactivada'}.`);

while (true) {
  try {
    const updates = await tg.getUpdates(Number(store.get('offset') ?? 0));
    for (const u of updates) await bot.onUpdate(u);
  } catch (err) {
    console.error('Error al consultar Telegram:', err);
    await Bun.sleep(RETRY_MS);
  }
}
