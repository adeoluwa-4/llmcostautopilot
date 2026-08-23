function approximateUsage(request, text) {
  const input = request.messages.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0);
  return {
    prompt_tokens: Math.max(1, Math.ceil(input / 4)),
    completion_tokens: Math.max(1, Math.ceil(text.length / 4)),
  };
}

export class ProviderError extends Error {
  constructor(message, { status = 502, retryable = true, cause } = {}) {
    super(message, { cause });
    this.name = "ProviderError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class MockProvider {
  async complete({ model, request }) {
    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === "user");
    const prompt = typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "Request completed";
    const jsonRequested = ["json_object", "json_schema"].includes(request.response_format?.type);
    const text = jsonRequested
      ? JSON.stringify({ result: prompt, model: model.id })
      : `[${model.tier}] ${prompt}`;
    const usage = approximateUsage(request, text);

    return {
      id: `mock_${crypto.randomUUID()}`,
      text,
      finishReason: "stop",
      usage: {
        ...usage,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
      raw: null,
    };
  }
}

export class OpenAICompatibleProvider {
  constructor({ baseUrl, apiKey, timeoutMs = 30_000, fetchImpl = fetch }) {
    if (!baseUrl) throw new Error("baseUrl is required for the upstream provider");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async complete({ model, request }) {
    const headers = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: model.providerModelId,
          messages: request.messages,
          max_tokens: request.max_tokens,
          temperature: request.temperature,
          response_format: request.response_format,
          tools: request.tools,
          tool_choice: request.tool_choice,
          stream: false,
          user: request.metadata?.user_id,
        }),
      });
    } catch (error) {
      throw new ProviderError("The upstream provider could not be reached", { cause: error });
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ProviderError(payload.error?.message || `Upstream provider returned HTTP ${response.status}`, {
        status: response.status === 429 ? 429 : 502,
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }

    const choice = payload.choices?.[0];
    if (!choice || typeof choice.message?.content !== "string") {
      throw new ProviderError("The upstream provider returned an unsupported response shape", { retryable: false });
    }

    return {
      id: payload.id || `upstream_${crypto.randomUUID()}`,
      text: choice.message.content,
      finishReason: choice.finish_reason || "stop",
      usage: payload.usage || approximateUsage(request, choice.message.content),
      raw: payload,
    };
  }
}

export function providerFromEnvironment(env = process.env) {
  if (!env.AUTOPILOT_UPSTREAM_BASE_URL) return new MockProvider();
  const timeoutMs = Number(env.AUTOPILOT_UPSTREAM_TIMEOUT_MS || 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("AUTOPILOT_UPSTREAM_TIMEOUT_MS must be a positive number");
  }
  return new OpenAICompatibleProvider({
    baseUrl: env.AUTOPILOT_UPSTREAM_BASE_URL,
    apiKey: env.AUTOPILOT_UPSTREAM_API_KEY,
    timeoutMs,
  });
}
