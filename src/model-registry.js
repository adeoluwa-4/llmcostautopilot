const TIERS = ["economy", "balanced", "premium"];

const DEFAULT_MODELS = [
  {
    id: "economy",
    provider: "mock",
    providerModelId: "mock/economy",
    tier: "economy",
    quality: 0.62,
    inputPrice: 0.1,
    outputPrice: 0.4,
    contextLimit: 32_000,
    maxOutputTokens: 4_096,
    capabilities: ["text", "json_schema", "tools"],
    rollingLatencyMs: 450,
    rollingErrorRate: 0.01,
  },
  {
    id: "balanced",
    provider: "mock",
    providerModelId: "mock/balanced",
    tier: "balanced",
    quality: 0.82,
    inputPrice: 0.8,
    outputPrice: 3.2,
    contextLimit: 128_000,
    maxOutputTokens: 16_384,
    capabilities: ["text", "json_schema", "tools", "vision"],
    rollingLatencyMs: 900,
    rollingErrorRate: 0.015,
  },
  {
    id: "premium",
    provider: "mock",
    providerModelId: "mock/premium",
    tier: "premium",
    quality: 0.97,
    inputPrice: 4,
    outputPrice: 16,
    contextLimit: 256_000,
    maxOutputTokens: 32_768,
    capabilities: ["text", "json_schema", "tools", "vision"],
    rollingLatencyMs: 1_800,
    rollingErrorRate: 0.02,
  },
];

function assertNumber(value, name, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
}

function normalizeModel(model, index) {
  const name = `models[${index}]`;
  if (!model || typeof model !== "object") throw new Error(`${name} must be an object`);
  if (!model.id || typeof model.id !== "string") throw new Error(`${name}.id is required`);
  if (!model.providerModelId || typeof model.providerModelId !== "string") {
    throw new Error(`${name}.providerModelId is required`);
  }
  if (!TIERS.includes(model.tier)) throw new Error(`${name}.tier must be ${TIERS.join(", ")}`);
  assertNumber(model.quality, `${name}.quality`, { max: 1 });
  assertNumber(model.inputPrice, `${name}.inputPrice`);
  assertNumber(model.outputPrice, `${name}.outputPrice`);
  assertNumber(model.contextLimit, `${name}.contextLimit`, { min: 1 });
  assertNumber(model.maxOutputTokens, `${name}.maxOutputTokens`, { min: 1 });
  if (!Array.isArray(model.capabilities) || model.capabilities.length === 0) {
    throw new Error(`${name}.capabilities must be a non-empty array`);
  }

  return Object.freeze({
    provider: "configured",
    rollingLatencyMs: 1_000,
    rollingErrorRate: 0.02,
    ...model,
    capabilities: Object.freeze([...new Set(model.capabilities)]),
  });
}

export function createRegistry(models = DEFAULT_MODELS, env = process.env) {
  const source = models.map((model) => ({ ...model }));
  const modelOverrides = {
    economy: env.AUTOPILOT_ECONOMY_MODEL,
    balanced: env.AUTOPILOT_BALANCED_MODEL,
    premium: env.AUTOPILOT_PREMIUM_MODEL,
  };

  const normalized = source.map((model, index) =>
    normalizeModel(
      {
        ...model,
        providerModelId: modelOverrides[model.tier] || model.providerModelId,
        provider: env.AUTOPILOT_UPSTREAM_BASE_URL ? "upstream" : model.provider,
      },
      index,
    ),
  );

  const ids = new Set();
  for (const model of normalized) {
    if (ids.has(model.id)) throw new Error(`Duplicate model id: ${model.id}`);
    ids.add(model.id);
  }
  return Object.freeze(normalized);
}

export function registryFromEnvironment(env = process.env) {
  if (!env.AUTOPILOT_MODELS_JSON) return createRegistry(DEFAULT_MODELS, env);

  let models;
  try {
    models = JSON.parse(env.AUTOPILOT_MODELS_JSON);
  } catch {
    throw new Error("AUTOPILOT_MODELS_JSON must contain valid JSON");
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("AUTOPILOT_MODELS_JSON must contain a non-empty array");
  }
  return createRegistry(models, env);
}

export function estimateCost(model, inputTokens, outputTokens) {
  return (inputTokens * model.inputPrice + outputTokens * model.outputPrice) / 1_000_000;
}

export function publicModel(model) {
  return {
    id: model.id,
    provider: model.provider,
    provider_model_id: model.providerModelId,
    tier: model.tier,
    quality: model.quality,
    input_price_per_million: model.inputPrice,
    output_price_per_million: model.outputPrice,
    context_limit: model.contextLimit,
    max_output_tokens: model.maxOutputTokens,
    capabilities: model.capabilities,
  };
}

export { DEFAULT_MODELS, TIERS };
