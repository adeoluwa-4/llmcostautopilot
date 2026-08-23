import { estimateCost } from "./model-registry.js";

const QUALITY_FLOORS = {
  economy: 0.45,
  standard: 0.58,
  maximum: 0.88,
};

const TASK_DIFFICULTY = {
  classification: 0.05,
  extraction: 0.08,
  rewrite: 0.1,
  translation: 0.14,
  summarization: 0.22,
  chat: 0.24,
  generation: 0.3,
  coding: 0.42,
  planning: 0.48,
  research: 0.58,
  unknown: 0.32,
};

export class RoutingError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "RoutingError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function estimateTokens(messages) {
  const characters = messages.reduce((sum, message) => sum + messageText(message.content).length, 0);
  return Math.max(1, Math.ceil(characters / 4) + messages.length * 4);
}

function validateRequest(request) {
  if (!request || typeof request !== "object") {
    throw new RoutingError("invalid_request", "Request body must be a JSON object");
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new RoutingError("invalid_messages", "messages must be a non-empty array");
  }
  for (const [index, message] of request.messages.entries()) {
    if (!message || !["system", "user", "assistant", "tool"].includes(message.role)) {
      throw new RoutingError("invalid_message", `messages[${index}].role is invalid`);
    }
    if (!messageText(message.content)) {
      throw new RoutingError("invalid_message", `messages[${index}].content must contain text`);
    }
  }
  if (request.quality && !Object.hasOwn(QUALITY_FLOORS, request.quality)) {
    throw new RoutingError("invalid_quality", "quality must be economy, standard, or maximum");
  }
  if (request.max_cost_usd !== undefined && (!Number.isFinite(request.max_cost_usd) || request.max_cost_usd <= 0)) {
    throw new RoutingError("invalid_budget", "max_cost_usd must be greater than zero");
  }
  if (request.max_tokens !== undefined && (!Number.isInteger(request.max_tokens) || request.max_tokens <= 0)) {
    throw new RoutingError("invalid_max_tokens", "max_tokens must be a positive integer");
  }
}

function inferTask(request, text) {
  if (request.task && Object.hasOwn(TASK_DIFFICULTY, request.task)) return request.task;
  const lower = text.toLowerCase();
  if (/\b(classify|category|sentiment|label)\b/.test(lower)) return "classification";
  if (/\b(extract|fields?|json|parse)\b/.test(lower)) return "extraction";
  if (/\b(rewrite|rephrase|proofread)\b/.test(lower)) return "rewrite";
  if (/\b(translate|translation)\b/.test(lower)) return "translation";
  if (/\b(summarize|summary)\b/.test(lower)) return "summarization";
  if (/\b(code|debug|implement|function|typescript|javascript|python|sql)\b/.test(lower)) return "coding";
  if (/\b(research|sources?|citations?|compare evidence)\b/.test(lower)) return "research";
  if (/\b(plan|strategy|architecture|design)\b/.test(lower)) return "planning";
  return request.task || "chat";
}

function requiredCapabilities(request) {
  const required = new Set(["text", ...(request.required_capabilities || [])]);
  if (request.response_format?.type === "json_object" || request.response_format?.type === "json_schema") {
    required.add("json_schema");
  }
  if (Array.isArray(request.tools) && request.tools.length > 0) required.add("tools");
  return [...required];
}

function scoreComplexity(request, inputTokens, task, text) {
  const context = Math.min(inputTokens / 32_000, 1);
  const constraints = Math.min((text.match(/\b(must|should|ensure|require|without|only|exactly|never)\b/gi) || []).length / 8, 1);
  const turns = Math.min(request.messages.length / 12, 1);
  const tools = Math.min((request.tools?.length || 0) / 4, 1);
  const specialistTerms = Math.min((text.match(/\b(legal|medical|financial|security|compliance|production|proof|theorem)\b/gi) || []).length / 3, 1);
  const consequence = request.risk === "high" ? 1 : request.risk === "medium" ? 0.5 : specialistTerms;
  const taskDifficulty = TASK_DIFFICULTY[task] ?? TASK_DIFFICULTY.unknown;

  return Math.min(
    1,
    0.12 * context +
      0.12 * constraints +
      0.08 * turns +
      0.1 * tools +
      0.12 * specialistTerms +
      0.16 * consequence +
      0.3 * Math.min(taskDifficulty / 0.58, 1),
  );
}

function round(value, places = 6) {
  return Number(value.toFixed(places));
}

function routeReasons({ task, complexity, inputTokens, capabilities, selected, qualityFloor }) {
  const reasons = [`task:${task}`, `complexity:${complexity.toFixed(2)}`, `quality_floor:${qualityFloor.toFixed(2)}`];
  reasons.push(inputTokens > 16_000 ? "large_context" : "context_within_standard_range");
  if (capabilities.length > 1) reasons.push(`requires:${capabilities.slice(1).join(",")}`);
  reasons.push(`lowest_cost_qualified:${selected.id}`);
  return reasons;
}

export function createRouter(registry) {
  if (!Array.isArray(registry) || registry.length === 0) throw new Error("A non-empty model registry is required");

  return {
    route(request) {
      validateRequest(request);
      const text = request.messages.map((message) => messageText(message.content)).join("\n");
      const inputTokens = estimateTokens(request.messages);
      const outputTokens = request.max_tokens || 512;
      const task = inferTask(request, text);
      const capabilities = requiredCapabilities(request);
      const complexity = scoreComplexity(request, inputTokens, task, text);
      const baseFloor = QUALITY_FLOORS[request.quality || "standard"];
      const riskAdjustment = request.risk === "high" ? 0.18 : request.risk === "medium" ? 0.07 : 0;
      const qualityFloor = Math.min(0.98, baseFloor + complexity * 0.24 + riskAdjustment);
      const fixedModel = request.routing?.model;
      const fixedTier = request.routing?.tier;

      const candidates = registry
        .filter((model) => !fixedModel || model.id === fixedModel)
        .filter((model) => !fixedTier || model.tier === fixedTier)
        .filter((model) => inputTokens + outputTokens <= model.contextLimit)
        .filter((model) => outputTokens <= model.maxOutputTokens)
        .filter((model) => capabilities.every((capability) => model.capabilities.includes(capability)))
        .map((model) => {
          const estimatedCost = estimateCost(model, inputTokens, outputTokens);
          const utility = model.quality - estimatedCost * 8 - model.rollingErrorRate - model.rollingLatencyMs / 1_000_000;
          return { model, estimatedCost, utility };
        })
        .filter((candidate) => request.max_cost_usd === undefined || candidate.estimatedCost <= request.max_cost_usd)
        .sort((a, b) => a.estimatedCost - b.estimatedCost || b.utility - a.utility);

      if (candidates.length === 0) {
        throw new RoutingError(
          "no_eligible_model",
          "No model satisfies the requested capabilities, context, output, routing, and budget constraints",
          422,
          { input_tokens: inputTokens, required_capabilities: capabilities },
        );
      }

      const selected = candidates.find((candidate) => candidate.model.quality >= qualityFloor) || candidates.at(-1);
      if (!selected || (request.quality === "maximum" && selected.model.quality < qualityFloor)) {
        throw new RoutingError("quality_unavailable", "No eligible model meets the requested quality target", 422);
      }

      const escalationCandidates = candidates
        .filter((candidate) => candidate.model.quality > selected.model.quality)
        .sort((a, b) => a.model.quality - b.model.quality);
      const routePlan = [selected, ...escalationCandidates];

      return {
        selected: selected.model,
        candidates: routePlan.map((candidate) => candidate.model),
        estimates: Object.fromEntries(
          routePlan.map((candidate) => [candidate.model.id, round(candidate.estimatedCost)]),
        ),
        inputTokens,
        outputTokens,
        task,
        complexity: round(complexity, 4),
        qualityFloor: round(qualityFloor, 4),
        requiredCapabilities: capabilities,
        reasons: routeReasons({
          task,
          complexity,
          inputTokens,
          capabilities,
          selected: selected.model,
          qualityFloor,
        }),
      };
    },
  };
}
