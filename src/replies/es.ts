// Todo lo que el bot le dice al usuario. El tono ("hey man, suave") se cambia solo aquí.
import { WEEKDAYS, weekday, type Day } from '../domain/dates';
import type { Ledger, Txn } from '../domain/ledger';
import { fmt, fmtUsd } from '../domain/money';
import type { MonthReport } from '../domain/reports';
import type { CardStatus, Snapshot } from '../domain/snapshot';

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
  for (const f of s.fixedUpcoming) {
    if (f.reserve > 0) lines.push(`Fijo ${f.name} (${shortDay(f.date)}): apartado ${fmt(f.reserve)} de ${fmt(f.amount)}`);
  }
  for (const c of s.cards) {
    lines.push(cardLine(c));
    if (c.reserve > 0) lines.push(`  Apartado para pagarla: ${fmt(c.reserve)}`);
  }
  return `${lines.join('\n')}\n\n${brief(s)}`;
}

/** Monto en soles; si fue en dólares, muestra ambos y el tipo de cambio. */
export const money = (pen: number, usd: number | null, rate: number | null = null) =>
  usd === null ? fmt(pen) : `${fmtUsd(usd)} (${fmt(pen)}${rate ? ` a ${rate.toFixed(3)}` : ''})`;

export function askReply(s: Snapshot, shown: string): string {
  const opening = s.state === 'alerta' ? 'Mejor no.' : s.state === 'suave' ? 'Se puede, pero suave.' : 'Dale.';
  return `${opening} Con ${shown} menos:\n${brief(s)}\n\nNo anoté nada. Si lo compras, regístralo.`;
}

/** Los ejemplos usan tu primera tarjeta, para que puedas copiarlos tal cual. */
export const helpText = (cards: string[]) => {
  const c = cards[0] ?? 'visa';
  return `Puedes escribirme como hablas, mandarme un audio o una captura de Yape. Por ejemplo: ayer gasté como 80 en la ${c}.

Atajos para registrar:
25 almuerzo: gasto con Yape o débito
$15 netflix ${c}: gasto en dólares (también 15 usd)
25 almuerzo #salidas: elige la categoría
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
mes: resumen del mes por categoría (mes pasado para el anterior)
deshacer: borra el último movimiento
ajustes: ve tus tarjetas, fijos e ingresos

Cómo cambiar ajustes:
fijo internet 80 dia 15
ingreso semana 400 domingo
ingreso quincena 350 dias 15,30
tarjeta visa linea 3000 cierre 20 pago 5
meta ahorro 50
dolar 3.75: fija el tipo de cambio (se actualiza solo cada día)
borrar fijo internet (también ingreso o tarjeta)`;
};

export function describeTxn(t: Txn, l: Ledger): string {
  const card = l.cards.find((c) => c.id === t.cardId)?.name;
  const label: Record<Txn['kind'], string> = {
    expense: t.description,
    income: `ingreso ${t.description}`.trim(),
    purchase: `${t.description} (${card ?? 'tarjeta'})`,
    payment: `pago ${card ?? 'tarjeta'}`,
    adjust: 'ajuste de saldo',
    debt_adjust: `${t.description} ${card ?? ''}`.trim(),
    saving: 'ahorro',
  };
  return `${shortDay(t.day)} ${label[t.kind]}: ${money(t.amount, t.original)}`;
}

export function settingsText(l: Ledger, usdRate: number | null): string {
  const lines = ['Tarjetas:'];
  for (const c of l.cards) lines.push(`${c.name}: línea ${fmt(c.limit)}, sale el ${c.closeDay}, pago hasta el ${c.dueDay}`);
  lines.push('', 'Ingresos:');
  for (const i of l.incomes) {
    lines.push(`${i.name}: ${fmt(i.amount)}, ${i.kind === 'weekly' ? `cada ${WEEKDAYS[i.weekday!]}` : `días ${i.days.join(', ')}`}`);
  }
  lines.push('', 'Fijos:');
  for (const f of l.fixed) lines.push(`${f.name}: ${fmt(f.amount)}, día ${f.day}`);
  lines.push('', `Meta de ahorro semanal: ${fmt(l.savingGoal)}`);
  lines.push(`Tipo de cambio: ${usdRate ? `S/ ${usdRate.toFixed(3)} por dólar` : 'aún no lo tengo'}`);
  return lines.join('\n');
}

/** Respuesta al pagar un fijo: dice cuánto se movió el libre, porque ya estaba apartado en parte o del todo. */
export function fixedPaidLine(name: string, shown: string, libreDelta: number): string {
  const effect =
    libreDelta === 0 ? 'Ya lo tenía apartado, tu libre no cambia.'
    : libreDelta < 0 ? `Tu libre bajó ${fmt(-libreDelta)}: faltaba apartar esa parte.`
    : `Tu libre subió ${fmt(libreDelta)}: tenía apartado más de lo que pagaste.`;
  return `Pagaste tu fijo ${name}: ${shown}. ${effect}`;
}

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1]!;
const prevMonthName = (m: string) => MONTHS[(Number(m.slice(5, 7)) + 10) % 12]!;
const CATEGORY_NAMES: Record<string, string> = { educacion: 'educación' };
const catName = (c: string) => CATEGORY_NAMES[c] ?? c;
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

export function monthSummary(r: MonthReport, current: boolean): string {
  const name = monthName(r.month);
  if (!r.spent && !r.fixedPaid && !r.income && !r.saved) return `No hay movimientos en ${name}.`;
  const lines = [`${current ? `En lo que va de ${name}` : `En ${name}`} gastaste ${fmt(r.spent)}, sin contar fijos.`];
  if (r.byCategory.length) {
    lines.push('', 'Por categoría:');
    for (const [cat, amount] of r.byCategory) lines.push(`${catName(cat)}: ${fmt(amount)} (${pct(amount, r.spent)}%)`);
  }
  const extra: string[] = [];
  if (r.fixedPaid) extra.push(`Fijos pagados: ${fmt(r.fixedPaid)}`);
  if (r.income) extra.push(`Ingresos: ${fmt(r.income)}`);
  if (r.saved) extra.push(`${r.saved > 0 ? 'Ahorraste' : 'Sacaste del ahorro'}: ${fmt(Math.abs(r.saved))}`);
  if (r.previousSpent !== null && !current) {
    const diff = r.spent - r.previousSpent;
    const prev = prevMonthName(r.month);
    if (diff === 0) extra.push(`Gastaste lo mismo que en ${prev}.`);
    else {
      const rel = r.previousSpent ? ` (${diff > 0 ? '+' : '-'}${pct(Math.abs(diff), r.previousSpent)}%)` : '';
      extra.push(`Gastaste ${fmt(Math.abs(diff))} ${diff > 0 ? 'más' : 'menos'} que en ${prev}${rel}.`);
    }
  }
  if (extra.length) lines.push('', ...extra);
  return lines.join('\n');
}

export const rateSaved = (rate: number) => `Tipo de cambio guardado: S/ ${rate.toFixed(3)} por dólar. Mañana lo vuelvo a actualizar solo.`;

export const dated = (day: Day, today: Day) => (day === today ? '' : ` Con fecha ${shortDay(day)}.`);

export const onboarding = {
  prompts: {
    saldo: '¿Cuánto tienes ahora en tu cuenta o Yape? Ejemplo: 820',
    tarjetas: 'Ahora tus tarjetas de crédito: nombre, línea, deuda actual, día en que sale la cuenta y último día de pago. Ejemplo: visa 1500 120 20 5. Puedes mandar varias, una por línea. Cuando termines, o si no tienes, escribe listo.',
    semana: '¿Cuánto te entra cada semana y qué día? Ejemplo: 400 domingo',
    quincena: '¿Cuánto es tu ingreso quincenal y qué días cae? Ejemplo: 350 15,30. Si no tienes, escribe no.',
    fijos: 'Ahora tus gastos fijos: nombre, monto y día del mes. Ejemplo: internet 80 15. Puedes mandar varios, uno por línea. Cuando termines, escribe listo.',
    ahorro: '¿Cuánto quieres apartar por semana? Ejemplo: 50. Si nada, escribe 0.',
  },
  welcome: (first: string) => `Hola, te configuro en unos pasos.\n\n${first}`,
  retry: (prompt: string) => `No te entendí. ${prompt}`,
  cardsSaved: (names: string[]) => `Anotada${names.length > 1 ? 's' : ''}: ${names.join(', ')}. Manda otra o escribe listo.`,
  fixedSaved: (names: string[]) => `Anotado${names.length > 1 ? 's' : ''}: ${names.join(', ')}. Manda otro o escribe listo.`,
  done: (s: Snapshot) => `Listo, ya estás configurado.\n\n${brief(s)}\n\nEscribe ayuda para ver los comandos.`,
  unfinished: 'Primero terminemos de configurarte.',
};

export const fallback = {
  notUnderstood: 'No te entendí, y no anoté nada. Cuéntamelo de otra forma, por ejemplo: gasté 25 en almuerzo.',
  unknownShortcut: 'No te entendí, y no anoté nada. Prueba con: 25 almuerzo. Escribe ayuda para ver los comandos.',
  aiDown: 'Ahora no puedo interpretar mensajes libres y no anoté nada. Mientras tanto usa: 25 almuerzo',
  aiDownSaved: (reply: string) => `${reply}\n\n(Sin IA por ahora: lo anoté con fecha de hoy. Si no es así, escribe deshacer.)`,
  photoNoAi: 'Para leer capturas me falta activar la IA. Por ahora anótalo así: 25 almuerzo',
  photoFailed: 'No pude leer la captura ahora y no anoté nada. Anótalo así: 25 almuerzo',
  photoTooBig: 'Esa imagen pesa mucho. Mándame una captura más liviana.',
  voiceNoAi: 'Para escuchar audios me falta activar la IA. Por ahora escríbelo: 25 almuerzo',
  voiceTooLong: 'Ese audio es muy largo. Mándame uno de menos de 2 minutos.',
  voiceEmpty: 'No escuché nada en ese audio. ¿Me lo repites?',
  voiceFailed: 'No pude escuchar el audio ahora y no anoté nada. Escríbelo: 25 almuerzo',
  heard: (text: string, reply: string) => `Escuché: "${text}"\n\n${reply}`,
  unsupported: 'Eso no lo entiendo todavía. Mándame texto, un audio o una captura.',
  noRate: 'Aún no tengo el tipo de cambio y no anoté nada. Dímelo así: dolar 3.75',
  photoDuplicate: 'Esa captura ya la anoté, no la vuelvo a registrar. Si de verdad fueron dos, escríbelo: 25 almuerzo',
  crashed: 'Algo falló y puede que no se haya anotado. Revisa con: ultimos',
};

export const access = {
  requested: 'Hola. Este bot es privado: le pedí acceso al dueño por ti. Te aviso apenas responda.',
  stillPending: 'Tu solicitud sigue pendiente. Te aviso apenas el dueño responda.',
  ownerRequest: (name: string, username: string, id: number) =>
    `Nueva solicitud de acceso:\n${name}${username ? ` (@${username})` : ''}, ID ${id}.\n\n¿Le das acceso? Tendrá su propia cuenta, separada de la tuya.`,
  approveButton: '✅ Aprobar',
  denyButton: '❌ Rechazar',
  approved: (name: string) => `Aprobado: ${name}. Ya puede usar el bot.`,
  denied: (name: string) => `Rechazado: ${name}. No le volveré a avisar si escribe.`,
  welcome: (first: string) =>
    `¡Listo, ya tienes acceso! Tu cuenta es solo tuya: nadie más la ve desde el bot.\n\nTen en cuenta que tus datos se guardan en el servidor del dueño del bot, y que los mensajes libres, audios y capturas se interpretan con IA (Groq o Claude).\n\n${first}`,
  rejected: 'El dueño no aprobó tu acceso a este bot.',
  revoked: (name: string) => `Le quité el acceso a ${name}. Sus datos se conservan por si lo vuelves a aprobar.`,
  restored: (name: string) => `Le devolví el acceso a ${name}.`,
  notFound: (id: number) => `No encontré a nadie con ID ${id}. Escribe usuarios para ver la lista.`,
  onlyOwner: 'Solo el dueño puede aprobar solicitudes.',
  alreadyDecided: 'Esa solicitud ya fue respondida.',
  list(members: { id: number; name: string; username: string; status: string }[]): string {
    if (!members.length) return 'Nadie más ha pedido acceso todavía.';
    const label: Record<string, string> = { pending: 'pendiente', approved: 'con acceso', denied: 'rechazado', revoked: 'sin acceso' };
    const lines = members.map((m) => `${m.name}${m.username ? ` (@${m.username})` : ''}, ID ${m.id}: ${label[m.status] ?? m.status}`);
    return `${lines.join('\n')}\n\nPara cambiar: aprobar ID, rechazar ID o quitar ID.`;
  },
};

export const notices = {
  weeklySummary(total: number, top: [string, number][], s: Snapshot): string {
    const lines = [`Resumen de la semana: gastaste ${fmt(total)}, sin contar fijos.`];
    if (top.length) lines.push(`Lo que más pesó: ${top.map(([n, a]) => `${catName(n)} ${fmt(a)}`).join(', ')}.`);
    lines.push('', brief(s), '', '¿Cuánto tienes de verdad en tu cuenta? Responde, por ejemplo: saldo 820');
    if (s.goalLeft > 0) lines.push(`Y si puedes, aparta tu ahorro: ahorro ${s.goalLeft / 100}`);
    return lines.join('\n');
  },
  cardClosed(card: string, alias: string, billed: number): string {
    const noted = billed > 0 ? `Salió tu cuenta ${card}: ${fmt(billed)} según lo anotado.` : `Hoy sale tu cuenta ${card}.`;
    return `${noted} Si tu estado dice otro monto, escríbeme: cuenta ${alias} 230. Cuando la pagues: pago ${alias}`;
  },
  cardDue: (card: string, daysLeft: number, billed: number) =>
    `Ojo, ${daysLeft === 0 ? 'hoy' : 'en 2 días'} vence ${card} y sigues debiendo ${fmt(billed)} de esa cuenta.`,
  incomeLate: (name: string, late: number, amount: number) =>
    `¿Ya te cayó ${name}? Debía llegar hace ${late} días. Si llegó, escribe: +${amount / 100} ${name}`,
  monthly: (r: MonthReport) => `Cerró ${monthName(r.month)}. ${monthSummary(r, false)}`,
  idle: (days: number) =>
    `Llevas ${days} días sin anotar nada. ¿Gastaste algo? Si no te acuerdas, pásame tu saldo: saldo 820`,
};
