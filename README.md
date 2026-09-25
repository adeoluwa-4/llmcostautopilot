# LLM Cost Autopilot

## What it does

LLM Cost Autopilot helps an AI app choose the least expensive model that can still do a request well. It checks the task, budget, needed features, and quality target, then can move to a stronger model when needed.

## What I built

I built the routing rules, model list, cost estimates, quality checks, provider connection, API, tests, browser console, and a local RAG pipeline with Node.js. The RAG flow indexes text documents, chunks them, creates deterministic local embeddings, retrieves matching context, and sends grounded prompts through the same cost-aware router.

Run `npm test` to test it and `npm start` to open the local app at `http://127.0.0.1:8787`.

## Main API

- `POST /v1/route` previews the selected model before spending tokens.
- `POST /v1/chat/completions` runs a routed OpenAI-compatible completion.
- `POST /v1/rag/documents` indexes a text document into the local RAG store.
- `POST /v1/rag/search` retrieves the most relevant chunks for a query.
- `POST /v1/rag/chat` retrieves context, injects it into the prompt, and runs a routed grounded completion.
- `GET /v1/models`, `GET /v1/metrics`, and `GET /health` expose model, usage, and service status.

## Local RAG Example

Index a document:

```bash
curl http://127.0.0.1:8787/v1/rag/documents \
  -H 'content-type: application/json' \
  -d '{
    "id": "support-runbook",
    "title": "Support Runbook",
    "text": "If a customer changes phones and reset emails stop arriving, ask them to verify the new device first."
  }'
```

Search the local index:

```bash
curl http://127.0.0.1:8787/v1/rag/search \
  -H 'content-type: application/json' \
  -d '{
    "query": "What should support do when reset emails stop after a phone change?",
    "top_k": 4
  }'
```

Run a grounded completion:

```bash
curl http://127.0.0.1:8787/v1/rag/chat \
  -H 'content-type: application/json' \
  -d '{
    "messages": [{"role": "user", "content": "What should support do when reset emails stop after a phone change?"}],
    "top_k": 4
  }'
```

## MVP Boundaries

- The default provider is a local mock provider, so local development has no external model cost.
- Real providers can be connected through the OpenAI-compatible upstream adapter.
- Metrics, RAG documents, and RAG chunks are stored in memory and reset when the process restarts.
- The RAG embeddings are deterministic local hashed embeddings for development, not provider-hosted neural embeddings.
- Streaming, persistent storage, tenant rate limits, circuit breakers, and production-grade calibration are future work.
