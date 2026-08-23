import { estimateCost, publicModel } from "./model-registry.js";
import { ProviderError } from "./provider.js";
import { RoutingError } from "./router.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function response(status, body, headers = {}) {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body };
}

function errorResponse(error) {
  if (error instanceof RoutingError) {
    return response(error.status, {
      error: { type: "routing_error", code: error.code, message: error.message, details: error.details },
    });
  }
  if (error instanceof ProviderError) {
    return response(error.status, {
      error: { type: "provider_error", code: "upstream_failure", message: error.message },
    });
  }
  return response(500, {
    error: { type: "internal_error", code: "internal_error", message: "An unexpected error occurred" },
  });
}

function validateOutput(request, completion) {
  if (!completion.text.trim()) return { valid: false, reason: "empty_output" };
  if (["json_object", "json_schema"].includes(request.response_format?.type)) {
    try {
      JSON.parse(completion.text);
    } catch {
      return { valid: false, reason: "invalid_json" };
    }
  }
  const minimum = request.validation?.min_output_characters;
  if (minimum && completion.text.length < minimum) {
    return { valid: false, reason: "output_too_short" };
  }
  return { valid: true, reason: "passed" };
}

function bearerToken(headers) {
  const value = headers.authorization || headers.Authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export function createApp({ router, registry, provider, apiKey } = {}) {
  if (!router || !registry || !provider) throw new Error("router, registry, and provider are required");

  const metrics = {
    requests: 0,
    completions: 0,
    failed: 0,
    escalations: 0,
    estimated_cost_usd: 0,
    actual_cost_usd: 0,
    routes_by_model: Object.fromEntries(registry.map((model) => [model.id, 0])),
  };

  async function complete(request, plan) {
    const attempts = [];
    let spent = 0;
    const allowEscalation = request.allow_escalation !== false;

    for (const [index, model] of plan.candidates.entries()) {
      if (index > 0 && !allowEscalation) break;
      const remainingBudget = request.max_cost_usd === undefined ? Number.POSITIVE_INFINITY : request.max_cost_usd - spent;
      const attemptEstimate = plan.estimates[model.id];
      if (attemptEstimate > remainingBudget) continue;

      const startedAt = performance.now();
      try {
        const completion = await provider.complete({ model, request });
        const latencyMs = Math.round(performance.now() - startedAt);
        const usage = {
          prompt_tokens: completion.usage?.prompt_tokens ?? plan.inputTokens,
          completion_tokens: completion.usage?.completion_tokens ?? plan.outputTokens,
        };
        usage.total_tokens = completion.usage?.total_tokens ?? usage.prompt_tokens + usage.completion_tokens;
        const actualCost = estimateCost(model, usage.prompt_tokens, usage.completion_tokens);
        spent += actualCost;
        const validation = validateOutput(request, completion);
        attempts.push({
          model: model.id,
          provider_model_id: model.providerModelId,
          estimated_cost_usd: attemptEstimate,
          actual_cost_usd: Number(actualCost.toFixed(6)),
          latency_ms: latencyMs,
          validation,
        });

        if (validation.valid) return { completion, model, attempts, actualCost: spent, usage };
        if (index < plan.candidates.length - 1) metrics.escalations += 1;
      } catch (error) {
        const latencyMs = Math.round(performance.now() - startedAt);
        attempts.push({
          model: model.id,
          provider_model_id: model.providerModelId,
          estimated_cost_usd: attemptEstimate,
          actual_cost_usd: 0,
          latency_ms: latencyMs,
          validation: { valid: false, reason: "provider_error" },
        });
        if (!(error instanceof ProviderError) || !error.retryable || index === plan.candidates.length - 1) throw error;
        metrics.escalations += 1;
      }
    }

    throw new RoutingError(
      "validation_failed",
      "No attempted model produced a valid response within the remaining budget",
      422,
      { attempts },
    );
  }

  return {
    metrics,

    async dispatch({ method, path, headers = {}, body }) {
      metrics.requests += 1;
      try {
        if (apiKey && bearerToken(headers) !== apiKey) {
          return response(401, {
            error: { type: "authentication_error", code: "invalid_api_key", message: "A valid bearer token is required" },
          });
        }

        if (method === "GET" && path === "/health") {
          return response(200, { status: "ok", service: "llm-cost-autopilot" });
        }
        if (method === "GET" && path === "/v1/models") {
          return response(200, { object: "list", data: registry.map(publicModel) });
        }
        if (method === "GET" && path === "/v1/metrics") {
          return response(200, { ...metrics });
        }
        if (method === "POST" && path === "/v1/route") {
          const plan = router.route(body);
          metrics.routes_by_model[plan.selected.id] += 1;
          metrics.estimated_cost_usd += plan.estimates[plan.selected.id];
          return response(200, {
            object: "autopilot.route",
            selected_model: plan.selected.id,
            provider_model_id: plan.selected.providerModelId,
            tier: plan.selected.tier,
            estimated_cost_usd: plan.estimates[plan.selected.id],
            input_tokens: plan.inputTokens,
            max_output_tokens: plan.outputTokens,
            task: plan.task,
            complexity: plan.complexity,
            quality_floor: plan.qualityFloor,
            required_capabilities: plan.requiredCapabilities,
            escalation_plan: plan.candidates.map((model) => model.id),
            reasons: plan.reasons,
          });
        }
        if (method === "POST" && path === "/v1/chat/completions") {
          if (body?.stream === true) {
            return response(400, {
              error: { type: "invalid_request_error", code: "streaming_not_implemented", message: "Streaming is not available in this MVP" },
            });
          }
          const plan = router.route(body);
          metrics.routes_by_model[plan.selected.id] += 1;
          metrics.estimated_cost_usd += plan.estimates[plan.selected.id];
          const result = await complete(body, plan);
          metrics.completions += 1;
          metrics.actual_cost_usd += result.actualCost;

          return response(
            200,
            {
              id: result.completion.id,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1_000),
              model: result.model.id,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: result.completion.text },
                  finish_reason: result.completion.finishReason,
                },
              ],
              usage: result.usage,
              autopilot: {
                selected_model: result.model.id,
                provider_model_id: result.model.providerModelId,
                tier: result.model.tier,
                task: plan.task,
                complexity: plan.complexity,
                reasons: plan.reasons,
                attempts: result.attempts,
                actual_cost_usd: Number(result.actualCost.toFixed(6)),
              },
            },
            {
              "x-autopilot-model": result.model.id,
              "x-autopilot-cost-usd": result.actualCost.toFixed(6),
            },
          );
        }

        return response(404, {
          error: { type: "not_found", code: "not_found", message: "Endpoint not found" },
        });
      } catch (error) {
        metrics.failed += 1;
        return errorResponse(error);
      }
    },
  };
}
