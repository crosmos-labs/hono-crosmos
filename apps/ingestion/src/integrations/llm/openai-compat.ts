import type {
  CompleteJsonOptions,
  CompleteOptions,
  LLM,
  LLMUsage,
} from './port';

/**
 * Shared implementation for any provider that speaks the OpenAI
 * `/chat/completions` wire format. OpenAI itself and OpenRouter both do —
 * they differ only in `baseUrl`, `Authorization` header, default model id,
 * and a handful of optional headers (e.g. OpenRouter's `HTTP-Referer`).
 *
 * Adapters subclass this and pass their concrete config; they don't
 * reimplement the request/response shape.
 */
export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  /** Extra headers attached to every request (e.g. OpenRouter attribution). */
  extraHeaders?: Record<string, string>;
  /** Human label included in thrown errors — e.g. "OpenAI", "OpenRouter". */
  providerLabel: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class OpenAICompatLLM implements LLM {
  readonly defaultModel: string;
  private _totalTokens = 0;

  constructor(private readonly config: OpenAICompatConfig) {
    this.defaultModel = config.defaultModel;
  }

  get totalTokens(): number {
    return this._totalTokens;
  }

  async complete(opts: CompleteOptions) {
    const body = {
      model: opts.model ?? this.defaultModel,
      temperature: opts.temperature,
      messages: this.messages(opts.system, opts.user),
    };
    const json = await this.request(body);
    return this.parseTextResponse(json);
  }

  async completeJson<T>(opts: CompleteJsonOptions) {
    const body = {
      model: opts.model ?? this.defaultModel,
      temperature: opts.temperature,
      messages: this.messages(opts.system, opts.user),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: opts.schema.name,
          schema: opts.schema.schema,
          strict: true,
        },
      },
    };
    const json = await this.request(body);
    const { content, usage } = this.parseTextResponse(json);
    let data: T;
    try {
      data = JSON.parse(content) as T;
    } catch (err) {
      throw new Error(
        `${this.config.providerLabel} returned non-JSON content despite json_schema response_format: ${(err as Error).message}`,
      );
    }
    return { data, usage };
  }

  private messages(system: string, user: string): ChatMessage[] {
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  private async request(body: unknown): Promise<ChatCompletionResponse> {
    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        ...this.config.extraHeaders,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LLMRequestError(
        `${this.config.providerLabel} ${res.status}: ${text || res.statusText}`,
        res.status,
      );
    }
    return (await res.json()) as ChatCompletionResponse;
  }

  private parseTextResponse(json: ChatCompletionResponse): {
    content: string;
    usage: LLMUsage;
  } {
    const content = json.choices[0]?.message.content;
    if (typeof content !== 'string') {
      throw new Error(
        `${this.config.providerLabel} response had no content (finish_reason=${json.choices[0]?.finish_reason})`,
      );
    }
    const usage: LLMUsage = {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    };
    this._totalTokens += usage.totalTokens;
    return { content, usage };
  }
}

export class LLMRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'LLMRequestError';
  }

  /** 429 / 5xx are worth retrying with backoff. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
