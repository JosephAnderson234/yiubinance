// Groq: chat con schema estricto y transcripción de audios con Whisper.
import { SCHEMA, SYSTEM } from './prompt';
import { AiUnavailable, TIMEOUT_MS, type Provider } from './provider';

const groqApi = () => process.env.GROQ_API ?? 'https://api.groq.com/openai/v1';

export function groqProvider(key: string, model: string, vision: boolean, reasoning: object): Provider {
  return {
    name: model,
    vision,
    async complete({ text, image }) {
      const content: object[] = [{ type: 'text', text }];
      if (image) content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } });
      const res = await fetch(`${groqApi()}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content }],
          response_format: { type: 'json_schema', json_schema: { name: 'lectura', strict: true, schema: SCHEMA } },
          max_completion_tokens: 1024,
          ...reasoning,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      return body.choices[0]!.message.content;
    },
  };
}

export async function groqTranscribe(key: string, audio: Blob, cards: string[]): Promise<string> {
  const form = new FormData();
  form.set('model', 'whisper-large-v3');
  form.set('language', 'es');
  form.set('response_format', 'json');
  form.set('prompt', ['Gastos en soles con Yape', ...cards.map((c) => `tarjeta ${c}`)].join(', ') + '.');
  form.set('file', audio, 'audio.ogg');
  const res = await fetch(`${groqApi()}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error(`Whisper: HTTP ${res.status}`);
    throw new AiUnavailable();
  }
  return ((await res.json()) as { text: string }).text.trim();
}
