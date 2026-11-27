// Punto de entrada: arma las piezas y corre el long polling de Telegram.
import { Access } from './adapters/access';
import { Bot } from './adapters/bot';
import { Store } from './adapters/store';
import { Telegram } from './adapters/telegram';
import { openErApi } from './app/fx';
import { loadConfig, type Config } from './config';
import { createAi } from './input/ai';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const store = new Store(config.dbPath);
const tg = new Telegram(config.token, config.telegramApi);
const ai = await createAi(process.env);
const access = new Access(config.ownerId, store, config.dataDir);
const bot = new Bot(tg, access, ai, openErApi);

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
    const updates = await tg.getUpdates(access.offset);
    for (const u of updates) await bot.onUpdate(u);
  } catch (err) {
    console.error('Error al consultar Telegram:', err);
    await Bun.sleep(RETRY_MS);
  }
}
