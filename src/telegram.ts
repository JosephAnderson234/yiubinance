export interface Update {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
    caption?: string;
    voice?: { file_id: string; duration: number };
    photo?: { file_id: string; file_size?: number }[];
  };
}

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
    return (await this.call('getUpdates', { offset, timeout, allowed_updates: ['message'] })) as Update[];
  }

  async send(chatId: number, text: string) {
    await this.call('sendMessage', { chat_id: chatId, text });
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
