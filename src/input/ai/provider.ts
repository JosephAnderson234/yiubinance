// Contrato común de los proveedores de IA.
export interface Image { base64: string; mime: string }
export interface Request { text: string; image?: Image }

export interface Provider {
  name: string;
  vision: boolean;
  complete(req: Request): Promise<string>;
}

export const TIMEOUT_MS = 20_000;

export class AiUnavailable extends Error {}
