// Interpreta mensajes libres con IA. Prueba cada proveedor en orden y nunca calcula dinero.
import { claudeProvider } from './claude';
import { groqProvider, groqTranscribe } from './groq';
import { isReading, type Reading } from './prompt';
import { AiUnavailable, type Provider, type Request } from './provider';

export class Ai {
  constructor(
    private readonly providers: Provider[],
    private readonly groqKey: string | null = null,
  ) {}

  get canHear() { return this.groqKey !== null; }

  /** Cualquier fallo (404, 429, 5xx, demora o JSON inválido) pasa al siguiente proveedor. */
  async read(req: Request): Promise<Reading> {
    const usable = this.providers.filter((p) => !req.image || p.vision);
    for (const p of usable) {
      try {
        const reading = JSON.parse(await p.complete(req));
        if (isReading(reading)) return reading;
        console.error(`IA ${p.name}: respuesta con formato inválido`);
      } catch (err) {
        // Solo el motivo: el texto de tus gastos nunca va a los logs.
        console.error(`IA ${p.name}: ${err instanceof Error ? err.message : 'error'}`);
      }
    }
    throw new AiUnavailable();
  }

  async transcribe(audio: Blob, cards: string[] = []): Promise<string> {
    if (!this.groqKey) throw new AiUnavailable();
    return groqTranscribe(this.groqKey, audio, cards);
  }
}

export async function createAi(env: Record<string, string | undefined>): Promise<Ai | null> {
  const providers: Provider[] = [];
  const groq = env.GROQ_API_KEY || null;
  if (groq) {
    providers.push(groqProvider(groq, 'qwen/qwen3.8-27b', true, { reasoning_effort: 'none' }));
    providers.push(groqProvider(groq, 'openai/gpt-oss-120b', false, { reasoning_effort: 'low', include_reasoning: false }));
  }
  if (env.ANTHROPIC_API_KEY) {
    providers.push(await claudeProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || 'claude-opus-5-5'));
  }
  return providers.length ? new Ai(providers, groq) : null;
}
