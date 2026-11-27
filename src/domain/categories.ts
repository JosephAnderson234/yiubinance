// Categorías fijas de gasto. La IA elige una; sin IA se deduce por palabras clave.
import { normalize } from './normalize';

export const CATEGORIES = [
  'comida', 'transporte', 'salidas', 'compras', 'hogar', 'salud',
  'educacion', 'suscripciones', 'servicios', 'otros',
] as const;
export type Category = (typeof CATEGORIES)[number];

const KEYWORDS: Record<Exclude<Category, 'otros'>, string[]> = {
  comida: [
    'almuerzo', 'desayuno', 'cena', 'menu', 'comida', 'lonche', 'cafe', 'pan', 'mercado', 'super', 'supermercado',
    'plaza vea', 'tottus', 'wong', 'metro', 'tambo', 'oxxo', 'pollo', 'chifa', 'pizza', 'hamburguesa', 'snack', 'fruta',
    'agua', 'gaseosa', 'rappi', 'pedidosya', 'kfc', 'bembos', 'mcdonalds', 'starbucks',
  ],
  transporte: ['taxi', 'uber', 'didi', 'cabify', 'indrive', 'bus', 'pasaje', 'combi', 'metropolitano', 'gasolina', 'grifo', 'peaje', 'estacionamiento', 'tren'],
  salidas: ['salida', 'cine', 'chela', 'cerveza', 'trago', 'bar', 'discoteca', 'fiesta', 'concierto', 'entrada', 'karaoke', 'juego', 'viaje'],
  compras: ['ropa', 'zapatillas', 'polo', 'casaca', 'pantalon', 'regalo', 'amazon', 'aliexpress', 'temu', 'saga', 'ripley', 'falabella', 'celular', 'audifonos', 'laptop'],
  hogar: ['alquiler', 'renta', 'limpieza', 'detergente', 'muebles', 'sodimac', 'promart', 'gas', 'balon'],
  salud: ['farmacia', 'inkafarma', 'mifarma', 'medicina', 'pastilla', 'doctor', 'medico', 'consulta', 'clinica', 'dentista', 'gym', 'gimnasio'],
  educacion: ['curso', 'libro', 'universidad', 'pension', 'matricula', 'copias', 'utiles', 'udemy', 'platzi'],
  suscripciones: ['netflix', 'spotify', 'youtube', 'disney', 'hbo', 'max', 'prime', 'icloud', 'google one', 'chatgpt', 'claude', 'suscripcion'],
  servicios: ['internet', 'luz', 'agua potable', 'sedapal', 'enel', 'luz del sur', 'telefono', 'plan', 'claro', 'movistar', 'entel', 'bitel', 'cable'],
};

export const isCategory = (s: string): s is Category => (CATEGORIES as readonly string[]).includes(s);

/** Primera categoría cuya palabra clave aparece completa en la descripción. */
export function categorize(description: string): Category {
  const text = ` ${normalize(description)} `;
  for (const [cat, words] of Object.entries(KEYWORDS) as [Category, string[]][]) {
    if (words.some((w) => text.includes(` ${w} `))) return cat;
  }
  return 'otros';
}
