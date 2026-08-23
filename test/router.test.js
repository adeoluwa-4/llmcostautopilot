import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "../src/model-registry.js";
import { createRouter, RoutingError } from "../src/router.js";

const router = createRouter(createRegistry());

function request(content, overrides = {}) {
  return { messages: [{ role: "user", content }], ...overrides };
}

test("routes a constrained classification request to the economy tier", () => {
  const plan = router.route(request("Classify this review as positive or negative."));
  assert.equal(plan.selected.id, "economy");
  assert.equal(plan.task, "classification");
  assert.deepEqual(plan.candidates.map((model) => model.id), ["economy", "balanced", "premium"]);
});

test("routes coding work to at least the balanced tier", () => {
  const plan = router.route(request("Implement a TypeScript function that deduplicates these records."));
  assert.equal(plan.selected.id, "balanced");
  assert.equal(plan.task, "coding");
});

test("routes maximum-quality work to the premium tier", () => {
  const plan = router.route(request("Design the production architecture.", { quality: "maximum" }));
  assert.equal(plan.selected.id, "premium");
});

test("filters models that lack a required capability", () => {
  const plan = router.route(request("Describe this image.", { required_capabilities: ["vision"] }));
  assert.equal(plan.selected.id, "balanced");
  assert.deepEqual(plan.requiredCapabilities, ["text", "vision"]);
});

test("honors a fixed tier override", () => {
  const plan = router.route(request("Say hello.", { routing: { tier: "premium" } }));
  assert.equal(plan.selected.id, "premium");
  assert.deepEqual(plan.candidates.map((model) => model.id), ["premium"]);
});

test("rejects a request when no model fits the budget", () => {
  assert.throws(
    () => router.route(request("Summarize this.", { max_cost_usd: 0.00000001 })),
    (error) => error instanceof RoutingError && error.code === "no_eligible_model" && error.status === 422,
  );
});

test("rejects malformed messages", () => {
  assert.throws(
    () => router.route({ messages: [] }),
    (error) => error instanceof RoutingError && error.code === "invalid_messages",
  );
});
