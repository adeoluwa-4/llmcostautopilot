import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createRegistry } from "../src/model-registry.js";
import { MockProvider } from "../src/provider.js";
import { createRagStore } from "../src/rag.js";
import { createRouter } from "../src/router.js";

function appWith({ provider = new MockProvider(), ragStore = createRagStore() } = {}) {
  const registry = createRegistry();
  return createApp({ registry, router: createRouter(registry), provider, ragStore });
}

test("ingests documents into searchable chunks", () => {
  const store = createRagStore();
  const document = store.ingest({
    id: "support-handbook",
    title: "Support Handbook",
    text: "Password resets expire after 15 minutes. Customers changing phones must verify the new device before email delivery resumes.",
  });

  const result = store.search({ query: "password reset new phone email", top_k: 2 });

  assert.equal(document.id, "support-handbook");
  assert.equal(document.chunks, 1);
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].document_id, "support-handbook");
  assert.match(result.matches[0].text, /verify the new device/);
});

test("replaces an existing document id instead of duplicating chunks", () => {
  const store = createRagStore();
  store.ingest({ id: "policy", text: "Old refund policy allows returns for seven days." });
  store.ingest({ id: "policy", text: "New refund policy allows returns for thirty days." });

  const result = store.search({ query: "refund returns thirty days", top_k: 5 });

  assert.equal(store.stats().documents, 1);
  assert.equal(store.stats().chunks, 1);
  assert.match(result.matches[0].text, /thirty days/);
});

test("runs grounded chat with retrieved citations", async () => {
  const app = appWith();
  await app.dispatch({
    method: "POST",
    path: "/v1/rag/documents",
    body: {
      id: "runbook",
      title: "Account Runbook",
      text: "If a user changes phones, ask them to verify the new device. Password reset emails resume after device verification.",
    },
  });

  const result = await app.dispatch({
    method: "POST",
    path: "/v1/rag/chat",
    body: {
      messages: [{ role: "user", content: "What should we do when a user changes phones and reset emails stop?" }],
      top_k: 2,
    },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.object, "chat.completion");
  assert.equal(result.body.rag.matches.length, 1);
  assert.equal(result.body.rag.matches[0].document_id, "runbook");
  assert.equal(result.body.autopilot.selected_model, "balanced");
  assert.equal(app.metrics.rag_ingestions, 1);
  assert.equal(app.metrics.rag_searches, 1);
  assert.equal(app.metrics.rag_context_chunks, 1);
});
