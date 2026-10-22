import type { Interpreter, InterpretInput, InterpretResult } from './interpreter.ts';
import { InterpretError, outputJsonSchema, parseModelText } from './output.ts';
import { SYSTEM_PROMPT, userText } from './prompt.ts';

export const META_MODEL_API = 'https://api.meta.ai/v1';

export interface MuseSparkOptions {
  readonly apiKey: string;
  /** A Standard-tier model. Contributor-tier models train on prompts and are refused. */
  readonly model?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/**
 * Muse Spark on Meta's Model API, through its OpenAI-compatible Chat Completions endpoint, with
 * strict JSON Schema output. Muse Spark grounds on the same 0 to 1000 top-left grid Boopy asks
 * for (dev.meta.ai/docs/image-understanding). The frame leaves this Mac for Meta.
 */
export class MuseSparkInterpreter implements Interpreter {
  readonly provider = 'meta-model-api';
  readonly model: string;
  readonly #options: MuseSparkOptions;
  readonly #schema = outputJsonSchema();

  constructor(options: MuseSparkOptions) {
    const model = options.model ?? 'muse-spark-1.3';
    if (model.endsWith('-contributor')) {
      throw new Error(`${model} trains on prompts, and Boopy's prompts show the person's room.`);
    }
    this.model = model;
    this.#options = options;
  }

  async interpret(input: InterpretInput, signal?: AbortSignal): Promise<InterpretResult> {
    const images = [input.image, ...(input.crop === null ? [] : [input.crop.image])].map(
      (image) => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` },
      }),
    );
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 60_000);
    const base = this.#options.baseUrl ?? META_MODEL_API;
    const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        // A short reasoning pass. Longer reasoning is too slow for a conversation turn.
        reasoning_effort: 'minimal',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [{ type: 'text', text: userText(input) }, ...images] },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'boopy_interpretation', schema: this.#schema, strict: true },
        },
        temperature: 0.2,
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new InterpretError(
        `The Meta Model API answered ${response.status}.`,
        body.slice(0, 2000),
      );
    }
    const content = (JSON.parse(body) as { choices?: { message?: { content?: unknown } }[] })
      .choices?.[0]?.message?.content;
    if (typeof content !== 'string')
      throw new InterpretError('The Meta Model API sent no message.', body);
    return { output: parseModelText(content), raw: content };
  }
}
