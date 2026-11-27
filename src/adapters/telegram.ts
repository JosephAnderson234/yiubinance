export interface User { id: number; first_name?: string; last_name?: string; username?: string }

export interface Update {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: User;
    text?: string;
    caption?: string;
    voice?: { file_id: string; duration: number };
    photo?: { file_id: string; file_unique_id?: string; file_size?: number }[];
  };
  /** Toque en un botón inline. */
  callback_query?: {
    id: string;
    from: User;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

/** Fila de botones inline: [texto, dato que vuelve en callback_query.data]. */
export type Buttons = [string, string][];

export class Telegram {
  private readonly base: string;
  private readonly files: string;

  constructor(token: string, api = 'https://api.telegram.org') {
    this.base = `${api}/bot${token}`;
    this.files = `${api}/file/bot${token}`;
  }

  private async unwrap(res: Response) {
    const body = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!body.ok) throw new Error(`Telegram: ${body.description ?? res.status}`);
    return body.result;
  }

  private async call(method: string, payload: object) {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return this.unwrap(res);
  }

  async getUpdates(offset: number, timeout = 30) {
    return (await this.call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] })) as Update[];
  }

  async send(chatId: number, text: string, buttons?: Buttons) {
    const markup = buttons && { reply_markup: { inline_keyboard: [buttons.map(([t, data]) => ({ text: t, callback_data: data }))] } };
    await this.call('sendMessage', { chat_id: chatId, text, ...markup });
  }

  /** Responde al toque de un botón (quita el reloj de carga en Telegram). */
  async answerCallback(id: string, text?: string) {
    await this.call('answerCallbackQuery', { callback_query_id: id, ...(text && { text }) });
  }

  /** Reemplaza el texto de un mensaje ya enviado y le quita los botones. */
  async edit(chatId: number, messageId: number, text: string) {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text });
  }

  async download(fileId: string): Promise<Blob> {
    const file = (await this.call('getFile', { file_id: fileId })) as { file_path: string };
    const res = await fetch(`${this.files}/${file.file_path}`);
    if (!res.ok) throw new Error(`Telegram: descarga ${res.status}`);
    return res.blob();
  }

  async sendDocument(chatId: number, path: string, filename: string) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('disable_notification', 'true');
    form.set('document', Bun.file(path), filename);
    await this.unwrap(await fetch(`${this.base}/sendDocument`, { method: 'POST', body: form }));
  }
}
