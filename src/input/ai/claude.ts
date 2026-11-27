// Claude: texto y capturas, con fallback de modelo del lado del servidor.
import { SCHEMA, SYSTEM } from './prompt';
import { TIMEOUT_MS, type Provider } from './provider';

export async function claudeProvider(key: string, model: string, baseURL?: string): Promise<Provider> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key, baseURL, timeout: TIMEOUT_MS, maxRetries: 0 });
  return {
    name: model,
    vision: true,
    async complete({ text, image }) {
      const content: any[] = [{ type: 'text', text }];
      if (image) content.unshift({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } });
      const res: any = await client.beta.messages.create({
        model,
        max_tokens: 4096,
        system: SYSTEM,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content }],
      } as any);
      if (res.stop_reason === 'refusal') throw new Error('rechazado');
      const block = res.content.find((b: any) => b.type === 'text');
      if (!block) throw new Error('sin texto');
      return block.text;
    },
  };
}
