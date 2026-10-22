import {
  type Interpreter,
  InterpreterUnavailableError,
  type InterpretInput,
  type InterpretResult,
} from './interpreter.ts';
import { InterpretError, outputJsonSchema, parseModelText } from './output.ts';
import { SYSTEM_PROMPT, userText } from './prompt.ts';

export interface OllamaOptions {
  /** Ollama's address on this Mac, for example http://127.0.0.1:11434. */
  readonly url: string;
  /** A vision model exactly as Ollama lists it, such as muse-glimmer:30b-mlx. */
  readonly model: string;
  readonly timeoutMs?: number;
  /** Whether the model reasons before answering; slower, sometimes better. */
  readonly think?: boolean;
}

/** Ollama's words when a model's engine cannot constrain output to a schema (MLX, 0.34.4). */
const NO_STRUCTURED_OUTPUT = 'structured output is unavailable';

/**
 * A local vision model through Ollama's chat API. Frames never leave this Mac. The output schema
 * is enforced through Ollama's structured outputs where the model supports them; where it does
 * not (Muse Glimmer and Qwen on Ollama's MLX engine), the schema goes into
 * the prompt instead and the answer is validated just as strictly.
 */
export class OllamaInterpreter implements Interpreter {
  readonly provider = 'ollama';
  readonly model: string;
  readonly #options: OllamaOptions;
  readonly #schema = outputJsonSchema();
  #structured = true;

  constructor(options: OllamaOptions) {
    this.model = options.model;
    this.#options = options;
  }

  async interpret(input: InterpretInput, signal?: AbortSignal): Promise<InterpretResult> {
    // Schema refusal is a retry within the same interpretation, not a fresh wait budget.
    const timeout = AbortSignal.timeout(this.#options.timeoutMs ?? 180_000);
    const deadline = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    if (this.#structured) {
      const answer = await this.#chat(input, true, deadline);
      if (answer !== null) return answer;
      this.#structured = false;
    }
    const answer = await this.#chat(input, false, deadline);
    if (answer === null) throw new InterpretError('Ollama refused the request.', '');
    return answer;
  }

  /** One chat request; null when the model cannot do structured output. */
  async #chat(
    input: InterpretInput,
    structured: boolean,
    signal: AbortSignal,
  ): Promise<InterpretResult | null> {
    const images = [input.image, ...(input.crop === null ? [] : [input.crop.image])].map((image) =>
      image.toString('base64'),
    );
    const system = structured
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT}\n\nAnswer with one JSON object, and nothing else, that matches this JSON Schema exactly:\n${JSON.stringify(this.#schema)}`;
    const response = await fetch(new URL('/api/chat', this.#options.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userText(input), images },
        ],
        ...(structured && { format: this.#schema }),
        stream: false,
        think: this.#options.think ?? false,
        keep_alive: '30m',
        options: { temperature: 0.2 },
      }),
      signal,
    }).catch((failure: unknown) => {
      if (
        ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(this.#options.url).hostname) &&
        failure instanceof TypeError &&
        typeof failure.cause === 'object' &&
        failure.cause !== null &&
        'code' in failure.cause &&
        failure.cause.code === 'ECONNREFUSED'
      )
        throw new InterpreterUnavailableError();
      throw failure;
    });
    const body = await response.text();
    if (!response.ok) {
      if (structured && response.status === 501 && body.includes(NO_STRUCTURED_OUTPUT)) return null;
      throw new InterpretError(`Ollama answered ${response.status}.`, body.slice(0, 2000));
    }
    const content = (JSON.parse(body) as { message?: { content?: unknown } }).message?.content;
    if (typeof content !== 'string') throw new InterpretError('Ollama sent no message.', body);
    return { output: parseModelText(content), raw: content };
  }
}
