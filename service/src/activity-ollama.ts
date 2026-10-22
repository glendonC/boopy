/** The only activity provider: one bounded request to Ollama on this Mac, without retries. */
import type { CallMetrics } from './activity-contract.ts';

export const DEFAULT_ACTIVITY_MODEL = 'qwen3.6:35b-a3b-nvfp4';
const LOCAL_DIGEST = 'e92a3e94bbca90a85491dc34e9257bfee2318cedaa16360828c4d8edf14295b9';
export class AssistantError extends Error {
  readonly code: 'assistant_unreachable' | 'assistant_error';
  constructor(code: 'assistant_unreachable' | 'assistant_error') {
    super(code);
    this.code = code;
  }
}

export class OllamaActivityAssistant {
  readonly provider = 'ollama' as const;
  readonly model: string;
  readonly #origin: string;

  constructor(input: { url: string; model?: string }) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error('Use a loopback Ollama HTTP URL without credentials or a path.');
    }
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Use a loopback Ollama HTTP URL without credentials or a path.');
    this.#origin = url.origin;
    this.model = input.model ?? DEFAULT_ACTIVITY_MODEL;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,44}$/.test(this.model) ||
      /grok/i.test(this.model) ||
      /:\/\/|www\.|\b(?:javascript|data|mailto|file|tel|sms|vbscript):\S/i.test(this.model)
    )
      throw new Error(
        'Use an installed local model name of at most 45 characters that does not mention Grok.',
      );
    if (this.model !== DEFAULT_ACTIVITY_MODEL)
      throw new Error('The activity assistant requires the verified local model.');
  }

  async ask(
    input: { system: string; user: string },
    signal: AbortSignal,
  ): Promise<{ content: string; metrics: CallMetrics | null }> {
    try {
      // Loopback alone is insufficient: Ollama may forward cloud model requests. Check the
      // artifact before disclosing a prompt, within the caller's one timeout and stop budget.
      const tags = await this.#metadata('/api/tags', signal);
      const local = Array.isArray(tags.models)
        ? tags.models.find((entry: Record<string, unknown>) => entry.name === this.model)
        : undefined;
      if (
        !local ||
        remote(local) ||
        local.digest !== LOCAL_DIGEST ||
        local.size !== 23598465691 ||
        local.details?.format !== 'safetensors'
      )
        throw new AssistantError('assistant_error');
      const show = await this.#metadata('/api/show', signal, { model: this.model });
      const info = show.model_info;
      if (
        remote(show) ||
        show.details?.format !== 'safetensors' ||
        info?.['general.architecture'] !== 'qwen3_5_moe' ||
        info?.['general.parameter_count'] !== 35951479808
      )
        throw new AssistantError('assistant_error');
      const response = await fetch(`${this.#origin}/api/chat`, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          stream: false,
          think: false,
          keep_alive: '30m',
          options: { temperature: 0.2, num_predict: 8192 },
        }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new AssistantError('assistant_error');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1024 * 1024) {
            await reader.cancel();
            throw new AssistantError('assistant_error');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (typeof body?.message?.content !== 'string') throw new AssistantError('assistant_error');
      const metrics: CallMetrics = {};
      for (const [key, field] of [
        ['totalMs', 'total_duration'],
        ['loadMs', 'load_duration'],
        ['promptEvalMs', 'prompt_eval_duration'],
        ['evalMs', 'eval_duration'],
      ] as const) {
        const value = body[field];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
          metrics[key] = Math.round(value / 100_000) / 10;
      }
      for (const [key, field] of [
        ['promptTokens', 'prompt_eval_count'],
        ['outputTokens', 'eval_count'],
      ] as const) {
        const value = body[field];
        if (Number.isSafeInteger(value) && value >= 0) metrics[key] = value;
      }
      return {
        content: body.message.content,
        metrics: Object.keys(metrics).length ? metrics : null,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AssistantError) throw error;
      throw new AssistantError(
        (error as { cause?: { code?: unknown } })?.cause?.code === 'ECONNREFUSED'
          ? 'assistant_unreachable'
          : 'assistant_error',
      );
    }
  }

  async #metadata(path: string, signal: AbortSignal, body?: { model: string }) {
    const response = await fetch(`${this.#origin}${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal,
      ...(body
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AssistantError('assistant_error');
    }
    const value = JSON.parse(await boundedMetadata(response));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AssistantError('assistant_error');
    return value;
  }
}

function remote(value: Record<string, unknown>) {
  return Object.keys(value).some((key) => /remote|cloud/i.test(key));
}

async function boundedMetadata(response: Response): Promise<string> {
  if (!response.body) throw new AssistantError('assistant_error');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new AssistantError('assistant_error');
      }
      chunks.push(chunk.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    reader.releaseLock();
  }
}
