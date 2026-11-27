// Todo el dinero se maneja en céntimos enteros para evitar errores de redondeo.
const toCents = (s: string) => Math.round(parseFloat(s) * 100);

export function parseAmount(raw: string): number | null {
  const s = raw.trim().replace(/^s\/\.?\s*/i, '');
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) return toCents(s.replace(/,/g, ''));
  if (/^\d+([.,]\d{1,2})?$/.test(s)) return toCents(s.replace(',', '.'));
  return null;
}

export function fmt(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const dec = abs % 100;
  return `${sign}S/ ${whole}${dec ? `.${String(dec).padStart(2, '0')}` : ''}`;
}
