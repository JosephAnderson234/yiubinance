// Tipo de cambio PEN/USD: se consulta una vez al día. Si la fuente falla, se usa el último conocido.
import type { Store } from '../adapters/store';
import { localDay } from '../domain/dates';
import { isSaneRate } from '../domain/money';

/** Devuelve soles por dólar, o null si no pudo obtenerlo. */
export type RateSource = () => Promise<number | null>;

const FX_TIMEOUT_MS = 10_000;

/** open.er-api.com: gratis, sin clave. Solo se pide la tabla pública del dólar; no se envía nada tuyo. */
export const openErApi: RateSource = async () => {
  const res = await fetch(process.env.FX_API ?? 'https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(FX_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; rates?: Record<string, number> };
  const rate = body.rates?.PEN;
  return body.result === 'success' && typeof rate === 'number' && isSaneRate(rate) ? rate : null;
};

/** Actualiza el tipo de cambio si aún no hay uno de hoy. Devuelve true si lo cambió. */
export async function refreshRate(store: Store, source: RateSource, ms: number): Promise<boolean> {
  const today = localDay(ms);
  if (store.usdRateDay === today) return false;
  let rate: number | null = null;
  try {
    rate = await source();
  } catch (err) {
    console.error(`Tipo de cambio: ${err instanceof Error ? err.message : 'error'}`);
  }
  if (rate === null || !isSaneRate(rate)) return false;
  store.setUsdRate(rate, today);
  return true;
}
