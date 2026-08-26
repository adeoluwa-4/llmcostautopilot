const form = document.querySelector("#request-form");
const previewButton = document.querySelector("#preview-route");
const refreshMetricsButton = document.querySelector("#refresh-metrics");
const apiStatus = document.querySelector("#api-status");
const selectedModel = document.querySelector("#selected-model");
const estimatedCost = document.querySelector("#estimated-cost");
const taskResult = document.querySelector("#task-result");
const complexityResult = document.querySelector("#complexity-result");
const escalationResult = document.querySelector("#escalation-result");
const reasonList = document.querySelector("#reason-list");
const completionOutput = document.querySelector("#completion-output");
const modelList = document.querySelector("#model-list");
const runtimeMetrics = document.querySelector("#runtime-metrics");

function dollars(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function formPayload() {
  const data = new FormData(form);
  const prompt = String(data.get("prompt") || "").trim();
  const task = String(data.get("task") || "");
  const budget = String(data.get("budget") || "");
  const maxTokens = Number(data.get("tokens") || 300);
  const requiredCapabilities = [];
  if (data.get("json")) requiredCapabilities.push("json");
  if (data.get("vision")) requiredCapabilities.push("vision");
  if (data.get("tools")) requiredCapabilities.push("tools");

  const payload = {
    messages: [{ role: "user", content: prompt }],
    quality_target: data.get("quality"),
    max_tokens: maxTokens,
    allow_escalation: Boolean(data.get("escalation")),
  };
  if (task) payload.task = task;
  if (budget) payload.max_cost_usd = Number(budget);
  if (requiredCapabilities.length) payload.required_capabilities = requiredCapabilities;
  if (data.get("json")) payload.response_format = { type: "json_object" };
  return payload;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) {
    const message = payload.error?.message || `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

function renderRoute(route) {
  selectedModel.textContent = `${route.selected_model} (${route.tier})`;
  estimatedCost.textContent = dollars(route.estimated_cost_usd);
  taskResult.textContent = route.task;
  complexityResult.textContent = `${Math.round(route.complexity * 100)} / 100`;
  escalationResult.textContent = route.escalation_plan.join(" -> ");
  reasonList.replaceChildren(
    ...route.reasons.map((reason) => {
      const item = document.createElement("li");
      item.textContent = reason.replaceAll("_", " ");
      return item;
    }),
  );
}

function renderModels(models) {
  modelList.replaceChildren(
    ...models.data.map((model) => {
      const item = document.createElement("article");
      item.className = "model-row";
      const summary = document.createElement("div");
      const title = document.createElement("h3");
      const provider = document.createElement("p");
      const details = document.createElement("dl");
      const context = metricNode("Context", model.context_limit.toLocaleString());
      const quality = metricNode("Quality", `${Math.round(model.quality * 100)}%`);

      title.textContent = model.id;
      provider.textContent = `${model.tier} tier, ${model.provider_model_id}`;
      summary.append(title, provider);
      details.append(context, quality);
      item.append(summary, details);
      return item;
    }),
  );
}

function metricNode(label, value) {
  const group = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  detail.textContent = value;
  group.append(term, detail);
  return group;
}

function renderMetrics(metrics) {
  const entries = [
    ["Requests", metrics.requests],
    ["Completions", metrics.completions],
    ["Failed", metrics.failed],
    ["Escalations", metrics.escalations],
    ["Estimated spend", dollars(metrics.estimated_cost_usd)],
    ["Actual spend", dollars(metrics.actual_cost_usd)],
  ];
  runtimeMetrics.replaceChildren(
    ...entries.map(([label, value]) => metricNode(label, String(value))),
  );
}

function setBusy(isBusy) {
  form.classList.toggle("is-busy", isBusy);
  previewButton.disabled = isBusy;
  form.querySelector("button[type='submit']").disabled = isBusy;
}

async function previewRoute() {
  setBusy(true);
  completionOutput.textContent = "Previewing route...";
  try {
    const route = await api("/v1/route", {
      method: "POST",
      body: JSON.stringify(formPayload()),
    });
    renderRoute(route);
    completionOutput.textContent = "Route preview complete. Run a completion when you want provider output.";
    await loadMetrics();
  } catch (error) {
    completionOutput.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function runCompletion(event) {
  event.preventDefault();
  setBusy(true);
  completionOutput.textContent = "Running completion...";
  try {
    const result = await api("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(formPayload()),
    });
    renderRoute({
      selected_model: result.autopilot.selected_model,
      tier: result.autopilot.tier,
      estimated_cost_usd: result.autopilot.attempts.at(-1)?.estimated_cost_usd || 0,
      task: result.autopilot.task,
      complexity: result.autopilot.complexity,
      escalation_plan: result.autopilot.attempts.map((attempt) => attempt.model),
      reasons: result.autopilot.reasons,
    });
    completionOutput.textContent = result.choices[0].message.content;
    await loadMetrics();
  } catch (error) {
    completionOutput.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function loadMetrics() {
  const metrics = await api("/v1/metrics");
  renderMetrics(metrics);
}

async function boot() {
  try {
    const [health, models] = await Promise.all([api("/health"), api("/v1/models")]);
    apiStatus.textContent = health.status;
    apiStatus.dataset.state = "ok";
    renderModels(models);
    await loadMetrics();
  } catch (error) {
    apiStatus.textContent = "offline";
    apiStatus.dataset.state = "error";
    completionOutput.textContent = error.message;
  }
}

previewButton.addEventListener("click", previewRoute);
form.addEventListener("submit", runCompletion);
refreshMetricsButton.addEventListener("click", loadMetrics);

boot();
