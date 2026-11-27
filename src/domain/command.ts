// Lo que el usuario pidió, ya interpretado. Lo producen los atajos y la IA; lo ejecuta app/execute.
import type { Day } from './dates';

export type Command =
  | { type: 'expense'; amount: number; description: string; cardId: number | null; day?: Day }
  | { type: 'ask'; amount: number; description: string; cardId: number | null }
  | { type: 'income'; amount: number; description: string; day?: Day }
  | { type: 'pay'; cardId: number; amount: number | null }
  | { type: 'statement'; cardId: number; amount: number }
  | { type: 'balance'; amount: number }
  | { type: 'saving'; amount: number }
  | { type: 'status' }
  | { type: 'undo' }
  | { type: 'recent' }
  | { type: 'settings' }
  | { type: 'help' }
  | { type: 'start' }
  | { type: 'set_fixed'; name: string; amount: number; day: number }
  | { type: 'set_income'; name: string; amount: number; weekday: number | null; days: number[] }
  | { type: 'set_card'; name: string; limit: number; closeDay: number; dueDay: number; debt: number }
  | { type: 'set_goal'; amount: number }
  | { type: 'remove'; what: 'fijo' | 'ingreso' | 'tarjeta'; name: string }
  | { type: 'unknown' };
