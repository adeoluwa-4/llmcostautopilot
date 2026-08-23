import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createRegistry } from "../src/model-registry.js";
import { MockProvider } from "../src/provider.js";
import { createRouter } from "../src/router.js";
import { createHttpServer } from "../src/server.js";

function appWith({ provider = new MockProvider(), apiKey } = {}) {
  const registry = createRegistry();
  return createApp({ registry, router: createRouter(registry), provider, apiKey });
}

function request(content, overrides = {}) {
  return { messages: [{ role: "user", content }], ...overrides };
}

test("returns a dry-run route with an explanation", async () => {
  const app = appWith();
  const result = await app.dispatch({
    method: "POST",
    path: "/v1/route",
    body: request("Classify this support ticket."),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.selected_model, "economy");
  assert.equal(result.body.object, "autopilot.route");
  assert.ok(result.body.estimated_cost_usd > 0);
  assert.ok(result.body.reasons.includes("lowest_cost_qualified:economy"));
});

test("returns an OpenAI-compatible completion with routing metadata", async () => {
  const app = appWith();
  const result = await app.dispatch({
    method: "POST",
    path: "/v1/chat/completions",
    body: request("Rewrite this sentence."),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.object, "chat.completion");
  assert.equal(result.body.model, "economy");
  assert.match(result.body.choices[0].message.content, /Rewrite this sentence/);
  assert.equal(result.body.autopilot.attempts.length, 1);
  assert.ok(result.body.usage.total_tokens > 0);
});

test("escalates when deterministic output validation fails", async () => {
  const provider = {
    async complete({ model }) {
      const text = model.id === "economy" ? "not-json" : JSON.stringify({ ok: true });
      return {
        id: `test_${model.id}`,
        text,
        finishReason: "stop",
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      };
    },
  };
  const app = appWith({ provider });
  const result = await app.dispatch({
    method: "POST",
    path: "/v1/chat/completions",
    body: request("Extract the fields as JSON.", {
      task: "extraction",
      response_format: { type: "json_object" },
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.model, "balanced");
  assert.equal(result.body.autopilot.attempts.length, 2);
  assert.equal(result.body.autopilot.attempts[0].validation.reason, "invalid_json");
  assert.equal(app.metrics.escalations, 1);
});

test("enforces an optional client API key", async () => {
  const app = appWith({ apiKey: "secret" });
  const denied = await app.dispatch({ method: "GET", path: "/health" });
  const allowed = await app.dispatch({
    method: "GET",
    path: "/health",
    headers: { authorization: "Bearer secret" },
  });

  assert.equal(denied.status, 401);
  assert.equal(allowed.status, 200);
});

test("serves the app through the HTTP adapter", async (t) => {
  const server = createHttpServer(appWith());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request("Classify this message.")),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.selected_model, "economy");
});
