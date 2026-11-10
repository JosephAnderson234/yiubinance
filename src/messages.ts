import { weekday, type Day } from './dates';
import type { CardStatus, Snapshot } from './engine';
import { fmt } from './money';

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const until = (s: Snapshot) => (s.cycleEnd === s.today ? 'hoy' : `el ${DAY_NAMES[weekday(s.cycleEnd)]}`);
const shortDay = (d: Day) => `${d.slice(8)}/${d.slice(5, 7)}`;

const VARIANTS = {
  sobrado: [
    'Date un buen gusto, te lo ganaste.',
    'Vas sobrado, un gustito no cae mal.',
    'Tranqui, esta semana te alcanza para darte un gusto.',
  ],
  normal: ['Vas bien.', 'Todo en orden, sigue así.', 'Tranqui, vas al ritmo.', 'Bien ahí, sin problemas.'],
  suave: [
    'Hey man, suave. A este ritmo no llegas hasta {until}.',
    'Hey man, baja un cambio: así no llegas hasta {until}.',
    'Suave con el gasto, a este ritmo no llegas hasta {until}.',
  ],
};

/** Varía el tono sin azar: el mismo estado con el mismo dinero dice lo mismo. */
const pick = (list: string[], s: Snapshot) => list[Math.abs(s.libre / 100 + s.daysLeft) % list.length | 0]!;

export function verdict(s: Snapshot): string {
  const a = s.alert;
  if (a?.type === 'over_limit') return `Espera, te pasaste ${fmt(a.amount)} de la línea de ${a.card}. Tienes que depositarlo.`;
  if (a?.type === 'gap') return `Espera, ya estás debiendo crédito. Para pagar ${a.card} te faltan ${fmt(a.amount)} con lo que entra seguro.`;
  if (a?.type === 'billed') return `Espera, ya estás debiendo crédito. Salió tu cuenta ${a.card} por ${fmt(a.amount)} y no te alcanza.`;
  if (a?.type === 'negative') return `Espera, te pasaste ${fmt(a.amount)} de lo que tenías libre.`;
  if (s.state === 'sobrado') return pick(VARIANTS.sobrado, s);
  if (s.lineWarning) return `Hey man, suave. Ya usaste ${Math.round(s.lineWarning.used * 100)}% de la línea de ${s.lineWarning.card}.`;
  if (s.state === 'suave') return pick(VARIANTS.suave, s).replace('{until}', until(s));
  return pick(VARIANTS.normal, s);
}

export function libreLine(s: Snapshot): string {
  if (s.libre < 0) return `Libre: ${fmt(s.libre)} hasta ${until(s)}.`;
  if (s.cycleEnd === s.today) return `Libre: ${fmt(s.libre)} hasta hoy.`;
  return `Libre: ${fmt(s.libre)} hasta ${until(s)} (~${fmt(s.perDay)} al día).`;
}

export const brief = (s: Snapshot) => `${libreLine(s)}\n${verdict(s)}`;

export function cardLine(c: CardStatus): string {
  if (c.over > 0) return `${c.card.name}: debes ${fmt(c.debt)}, ${fmt(c.over)} sobre la línea.`;
  return `${c.card.name}: debes ${fmt(c.debt)}, te quedan ${fmt(c.available)} de línea.`;
}

export function fullStatus(s: Snapshot): string {
  const lines = [`Saldo real: ${fmt(s.saldo)}`];
  if (s.savedTotal) lines.push(`Ahorro apartado: ${fmt(s.savedTotal)}`);
  if (s.goalLeft) lines.push(`Meta de ahorro pendiente: ${fmt(s.goalLeft)}`);
  for (const f of s.fixedPending) lines.push(`Fijo ${f.name}: ${fmt(f.amount)} (${shortDay(f.date)})`);
  for (const c of s.cards) {
    lines.push(cardLine(c));
    if (c.reserve > 0) lines.push(`  Apartado para pagarla: ${fmt(c.reserve)}`);
  }
  return `${lines.join('\n')}\n\n${brief(s)}`;
}

export function askReply(s: Snapshot, amount: number): string {
  const opening = s.state === 'alerta' ? 'Mejor no.' : s.state === 'suave' ? 'Se puede, pero suave.' : 'Dale.';
  return `${opening} Con ${fmt(amount)} menos:\n${brief(s)}\n\nNo anoté nada. Si lo compras, regístralo.`;
}

/** Los ejemplos usan tu primera tarjeta, para que puedas copiarlos tal cual. */
export const helpText = (cards: string[]) => {
  const c = cards[0] ?? 'visa';
  return `Puedes escribirme como hablas, mandarme un audio o una captura de Yape. Por ejemplo: ayer gasté como 80 en la ${c}.

Atajos para registrar:
25 almuerzo: gasto con Yape o débito
180 zapatillas ${c}: compra con tarjeta de crédito
pago ${c} 300: pago de tarjeta (pago ${c} = paga todo)
cuenta ${c} 230: corrige con el monto de tu estado de cuenta
+400 semana: ingreso
saldo 820: corrige tu saldo real
ahorro 50: aparta ahorro (retiro ahorro 50 lo devuelve)

Cómo consultar:
puedo 120 cena: te responde sin anotar nada
como voy: resumen completo
ultimos: últimos movimientos
deshacer: borra el último movimiento
ajustes: ve tus tarjetas, fijos e ingresos

Cómo cambiar ajustes:
fijo internet 80 dia 15
ingreso semana 400 domingo
ingreso quincena 350 dias 15,30
tarjeta visa linea 3000 cierre 20 pago 5
meta ahorro 50
borrar fijo internet (también ingreso o tarjeta)`;
};
