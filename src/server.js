import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { registryFromEnvironment } from "./model-registry.js";
import { providerFromEnvironment } from "./provider.js";
import { createRouter } from "./router.js";

const MAX_BODY_BYTES = 1_000_000;

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body exceeds 1 MB");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must contain valid JSON");
    error.status = 400;
    throw error;
  }
}

export function buildApp(env = process.env) {
  const registry = registryFromEnvironment(env);
  return createApp({
    registry,
    router: createRouter(registry),
    provider: providerFromEnvironment(env),
    apiKey: env.AUTOPILOT_API_KEY,
  });
}

export function createHttpServer(app = buildApp()) {
  return createServer(async (request, reply) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const result = await app.dispatch({
        method: request.method || "GET",
        path: url.pathname,
        headers: request.headers,
        body: ["POST", "PUT", "PATCH"].includes(request.method || "") ? await readJson(request) : undefined,
      });
      reply.writeHead(result.status, result.headers);
      reply.end(JSON.stringify(result.body));
    } catch (error) {
      const status = error.status || 500;
      reply.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      reply.end(
        JSON.stringify({
          error: {
            type: status < 500 ? "invalid_request_error" : "internal_error",
            code: status === 413 ? "body_too_large" : "invalid_json",
            message: status < 500 ? error.message : "An unexpected error occurred",
          },
        }),
      );
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("PORT must be a valid TCP port");
  const server = createHttpServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`LLM Cost Autopilot listening on http://127.0.0.1:${port}`);
  });
}
