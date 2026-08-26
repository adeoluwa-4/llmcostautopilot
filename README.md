# LLM Cost Autopilot

LLM Cost Autopilot is a provider-neutral routing layer that sits between an application and multiple large-language-model providers. It estimates what a request needs, selects the lowest-cost model likely to meet the quality target, executes the request, and escalates only when the result is inadequate.

## Working MVP

The repository now contains a dependency-free Node.js MVP with:

- `POST /v1/route` for dry-run routing decisions and explanations.
- `POST /v1/chat/completions` for OpenAI-compatible, non-streaming completions.
- `GET /v1/models`, `GET /v1/metrics`, and `GET /health`.
- A local browser console at `/` for route previews, completions, registry inspection, and runtime metrics.
- Capability, context-window, output-token, fixed-route, quality, and cost-budget filtering.
- Rule-based task inference and complexity scoring.
- Economy, balanced, and premium model aliases.
- Deterministic JSON and minimum-output validation.
- Automatic escalation after retryable provider or validation failures.
- Actual token-cost accounting and an in-memory operational summary.
- An optional client-facing bearer token.
- A mock provider for no-credential local development.
- A configurable OpenAI-compatible upstream adapter.

The default model names and prices are deliberately illustrative mock values. Configure the model registry with current identifiers and prices before using a real provider.

### Run it

Node.js 20 or newer is required. There are no packages to install.

```bash
npm test
npm start
```

The server listens on `http://127.0.0.1:8787` by default. Open that URL in a browser to use the local MVP console.

The browser console lets you:

- Preview the selected route before making a completion request.
- Run a routed completion through the configured provider.
- Inspect model tiers, quality scores, context limits, estimated cost, and runtime metrics.
- Test budget, quality target, output token, capability, and escalation controls without a paywall.

Preview a route without spending money:

```bash
curl http://127.0.0.1:8787/v1/route \
  -H 'content-type: application/json' \
  -d '{
    "messages": [{"role": "user", "content": "Extract the invoice fields as JSON."}],
    "task": "extraction",
    "response_format": {"type": "json_object"},
    "max_cost_usd": 0.01
  }'
```

Execute a routed completion:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "messages": [{"role": "user", "content": "Rewrite this sentence more clearly."}],
    "quality": "standard",
    "allow_escalation": true
  }'
```

Without upstream configuration, completions use the local mock provider and incur no external cost.

### Connect an upstream

Copy `.env.example` values into your shell or preferred secret manager. The adapter accepts any upstream that implements the OpenAI-compatible `POST /chat/completions` contract:

```bash
export AUTOPILOT_UPSTREAM_BASE_URL='https://your-upstream.example/v1'
export AUTOPILOT_UPSTREAM_API_KEY='replace-with-a-real-secret'
export AUTOPILOT_ECONOMY_MODEL='provider/current-economy-model'
export AUTOPILOT_BALANCED_MODEL='provider/current-balanced-model'
export AUTOPILOT_PREMIUM_MODEL='provider/current-premium-model'
npm start
```

For a managed multi-provider gateway, use model identifiers returned by that gateway's current model-discovery API or documentation. Do not copy the placeholder identifiers above into production.

To replace the complete registry, set `AUTOPILOT_MODELS_JSON` to a JSON array following the example in `.env.example`. Prices are expressed in USD per one million tokens.

### Current MVP boundaries

- Streaming is explicitly rejected and is the next protocol feature to add.
- Metrics reset whenever the process restarts.
- The rule weights and mock prices are configuration seeds, not trained predictions.
- JSON validation currently confirms syntax; full JSON Schema validation is a later milestone.
- The upstream adapter targets a common chat-completions contract. Provider-specific capabilities need dedicated adapters.
- Production use still needs persistent events, rate limiting, encrypted tenant configuration, circuit breakers, and benchmark calibration.

The core promise is not simply "always choose the cheapest model." It is:

> Minimize expected cost while meeting a measurable quality, latency, and reliability target.

## 1. What the product does

An application sends one normalized request to the Autopilot API. The router then:

1. Validates the request and tenant budget.
2. Detects required capabilities such as vision, tool use, JSON output, or a large context window.
3. Estimates task difficulty and response risk.
4. Filters out models that cannot satisfy the request.
5. Ranks the remaining models by predicted quality, cost, latency, and reliability.
6. Sends the request to the best candidate.
7. Validates the response and escalates to a stronger model only when necessary.
8. Logs the decision, token use, latency, cost, and outcome for later improvement.

```text
Client application
       |
       v
Unified Autopilot API
       |
       +--> Policy and budget checks
       |
       +--> Capability filter
       |
       +--> Complexity and risk scorer
       |
       +--> Model ranker --------> Model and pricing registry
       |
       +--> Provider adapter ----> OpenAI / Anthropic / Google / others
       |
       +--> Output validator ----> accept or escalate
       |
       v
Response + routing metadata + usage record
```

## 2. Start with a narrow MVP

The first release should support text generation, streaming, structured JSON output, three model tiers, two or three providers, per-request cost estimates, simple fallbacks, and a dashboard showing savings and quality.

Do not begin with a machine-learned router trained from scratch. There will be no useful labeled routing data on day one. Start with explainable rules and collect the data required to train a better policy.

### Suggested model tiers

Use aliases rather than hardcoding provider model names into application code:

| Tier | Intended work | Examples of signals |
| --- | --- | --- |
| Economy | Classification, extraction, rewriting, short factual responses | Short prompt, constrained output, low risk |
| Balanced | Summarization, ordinary coding, multi-step writing | Medium context, some reasoning, moderate risk |
| Premium | Difficult coding, long-horizon reasoning, high-stakes or ambiguous work | Large context, many constraints, tools, high risk |

The aliases map to real models in a versioned registry. Provider pricing and model availability change, so they should be refreshed from provider data or updated administratively without deploying application code.

## 3. Request contract

Clients should be allowed to express intent and constraints. The router should not guess everything from the prompt.

```json
{
  "messages": [
    { "role": "user", "content": "Extract the invoice fields as JSON" }
  ],
  "task": "extraction",
  "quality": "standard",
  "max_cost_usd": 0.02,
  "max_latency_ms": 5000,
  "required_capabilities": ["json_schema"],
  "allow_escalation": true,
  "metadata": {
    "user_id": "user_123",
    "feature": "invoice_import"
  }
}
```

Useful controls include:

- `quality`: economy, standard, or maximum.
- `max_cost_usd`: a hard ceiling for the complete attempt chain.
- `max_latency_ms`: the latency budget, including retries.
- `required_capabilities`: vision, tools, JSON schema, long context, and similar requirements.
- `sensitivity`: whether prompts may be sent to external providers and whether content may be logged.
- `routing`: automatic, fixed tier, fixed model, or dry-run.
- `allow_escalation`: whether the router may retry with a stronger model.

The response should contain the normal completion plus optional routing metadata:

```json
{
  "output": {},
  "route": {
    "tier": "economy",
    "reason": ["structured extraction", "short context", "low ambiguity"],
    "attempts": 1,
    "estimated_cost_usd": 0.0031,
    "actual_cost_usd": 0.0028,
    "latency_ms": 740
  }
}
```

## 4. The routing decision

### Stage A: deterministic capability filtering

Before estimating complexity, remove every model that cannot meet hard requirements:

- Input modality: text, image, audio, or documents.
- Minimum context window.
- Tool or function calling.
- Structured-output or JSON-schema support.
- Data residency and privacy policy.
- Provider availability and current error rate.
- Tenant allowlist or denylist.
- Estimated request cost within the budget.

This step is fast, cheap, and auditable.

### Stage B: complexity and risk scoring

Compute an initial score without calling an LLM. Useful signals include:

- Input-token estimate and requested output length.
- Task type: classification, extraction, summarization, generation, coding, planning, or research.
- Number of instructions, constraints, files, tools, and conversation turns.
- Need for multi-step reasoning or cross-document synthesis.
- Ambiguity, domain specialization, and required factual precision.
- Consequence of failure. A casual rewrite and a legal analysis should not share a policy.
- Historical performance for this tenant, feature, and task type.

For ambiguous requests, call a small classifier that returns structured features rather than directly choosing a provider model. This makes its behavior easier to evaluate and replace.

Example score:

```text
complexity =
    0.15 * normalized_context_length
  + 0.20 * reasoning_depth
  + 0.15 * constraint_count
  + 0.10 * tool_complexity
  + 0.15 * domain_specialization
  + 0.25 * consequence_of_failure
```

The exact weights should be configuration, not application constants. They will later be learned from observed results.

### Stage C: constrained model ranking

For each eligible model, estimate:

```text
utility(model) =
    predicted_quality
  - cost_weight * predicted_cost
  - latency_weight * predicted_latency
  - failure_weight * recent_failure_rate
```

Choose the cheapest candidate whose predicted quality clears the request's quality threshold. If none clears it, return a budget conflict or choose the highest-utility candidate only if the tenant's policy permits it.

### Stage D: validate and escalate

Cheap-first routing works only if weak responses are caught. Validators can include:

- JSON-schema validation.
- Required-field and citation checks.
- Code compilation or test execution in a sandbox.
- Tool-call validity.
- Grounding checks against supplied documents.
- A task-specific rubric evaluated by a separate model.
- User corrections, regenerations, and thumbs-down feedback.

If validation fails, retry with the next model in the route plan while respecting the remaining cost and latency budgets. Do not use a generic model-as-judge on every request; it can erase the savings. Prefer deterministic validation and sample-based quality auditing.

## 5. Model and pricing registry

Every model record should contain:

```text
id, provider, provider_model_id, tier, status
input_price, cached_input_price, output_price
context_limit, max_output_tokens
capabilities, regions, privacy_flags
rolling_latency, rolling_error_rate
quality_scores_by_task, updated_at
```

Keep pricing records effective-dated so historical cost reports remain correct after a provider changes its prices. Never calculate an old request using today's price.

## 6. Provider layer

Expose an OpenAI-compatible API where practical, then normalize every provider behind an adapter:

```text
generate(request) -> normalized response
stream(request)   -> normalized event stream
estimate(request) -> input/output token and cost estimate
health()          -> availability and latency state
```

There are two good implementation paths:

1. Use a managed multi-provider gateway for provider authentication, unified calls, failover, usage tracking, and observability, while keeping the Autopilot's scoring and policy engine above it.
2. Build direct provider adapters when provider-specific features, self-hosted models, data controls, or full infrastructure ownership require them.

The routing policy should remain independent from either path so infrastructure can change without rewriting product logic.

## 7. Data and learning loop

Log one routing event per attempt:

```text
request_id, tenant_id, task_type, feature_vector
eligible_models, selected_model, decision_reason
predicted_tokens, actual_tokens, cost, latency
validator_results, escalation_reason, user_feedback
provider_status, policy_version, registry_version
```

Do not log raw prompts or completions by default. Store redacted hashes or derived features unless a tenant explicitly enables content retention.

Once enough data exists, improve the router in this order:

1. Tune rule thresholds from real traffic.
2. Fit per-task quality and latency predictors.
3. Use shadow routing to compare decisions without affecting users.
4. Run controlled A/B tests.
5. Introduce a contextual-bandit policy only after guardrails and offline replay are reliable.

The learning objective should penalize quality failures much more heavily than small cost increases.

## 8. Evaluation strategy

Create a benchmark set grouped by task type and difficulty. For every candidate model, record pass rate, rubric score, latency, and real token cost.

The router's primary metrics are:

- Quality pass rate versus always using the premium model.
- Cost per successful request, not merely cost per request.
- Percentage of requests handled by each tier.
- Escalation rate and wasted cost before escalation.
- P50 and P95 latency.
- Provider error and fallback rates.
- Budget violations.
- User regeneration or correction rate.

A useful launch gate is a quality pass rate within an agreed margin of the premium baseline, with meaningful savings on the benchmark and shadow production traffic.

## 9. Suggested technical stack

- API and router: TypeScript with Fastify, Hono, or a Next.js API service.
- Validation: Zod or JSON Schema.
- State: PostgreSQL for tenants, policies, registry versions, and routing events.
- Fast counters and rate limits: Redis-compatible storage.
- Background work: a queue for evaluations, price refreshes, and aggregate metrics.
- Observability: OpenTelemetry traces plus a metrics and log backend.
- Dashboard: React or Next.js.
- Deployment: containerized service or serverless functions, depending on streaming and timeout needs.

Keep the first version as a modular monolith. Separate services are unnecessary until traffic or team ownership justifies them.

## 10. Security and reliability requirements

- Encrypt provider credentials and never expose them to clients.
- Redact secrets and personal data before logging.
- Support tenant-specific retention and provider policies.
- Rate-limit by tenant and end user.
- Add circuit breakers for unhealthy providers.
- Use idempotency keys so retries do not double-charge clients.
- Sign webhooks and authenticate every API request.
- Cap input tokens, output tokens, attempts, cost, and wall-clock time.
- Record the exact policy and registry versions behind every decision.
- Provide a fixed-model escape hatch for debugging and regulated workflows.

## 11. Build plan

### Phase 1: one-week proof of concept

- Define the normalized request and response contracts.
- Add adapters for three representative model tiers.
- Build a static model registry with editable pricing.
- Implement capability filtering and rule-based scoring.
- Estimate cost before the call and record actual usage afterward.
- Return a dry-run route explanation without invoking a model.
- Assemble a small labeled benchmark covering five task types.

### Phase 2: two-to-four-week MVP

- Add tenant API keys, policies, budgets, and rate limits.
- Add streaming and structured outputs.
- Add retries, provider failover, circuit breakers, and escalation.
- Build deterministic validators for the first supported task types.
- Add a dashboard for spend, savings, latency, quality, and route explanations.
- Run shadow routing against real application traffic.

### Phase 3: production learning system

- Automate pricing and availability refreshes.
- Train per-task quality, latency, and token-use predictors.
- Add experiment assignment, offline replay, and policy versioning.
- Add enterprise privacy controls, audit exports, and regional routing.
- Offer an SDK, OpenAI-compatible endpoint, and proxy mode.

## 12. Recommended first vertical

Begin with workloads that have objective validators: classification, structured extraction, summarization with required facts, or code generation with tests. They make it possible to prove that a cheaper route still meets the quality target.

General chat is a poor first benchmark because quality is subjective and conversations introduce long, changing context.

## 13. First implementation milestone

The first end-to-end milestone should demonstrate this exact loop:

1. Submit a request to `POST /v1/route` in dry-run mode.
2. Receive the selected tier, estimated price, and human-readable reasons.
3. Submit the same request to `POST /v1/chat/completions`.
4. Execute it against the selected model.
5. Validate the result and escalate if needed.
6. View the attempt chain, actual cost, latency, and estimated savings in a dashboard.

That slice proves the product's core value before investing in advanced machine learning.
