const DEFAULT_CHUNK_WORDS = 120;
const DEFAULT_OVERLAP_WORDS = 24;
const DEFAULT_DIMENSIONS = 128;
const MAX_DOCUMENT_CHARS = 120_000;
const MAX_TOP_K = 12;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
]);

export class RagError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "RagError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function assertObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RagError("invalid_request", `${name} must be a JSON object`);
  }
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g)
    ?.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) || [];
}

function hashToken(token) {
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function embedTokens(tokens, dimensions = DEFAULT_DIMENSIONS) {
  const vector = new Array(dimensions).fill(0);
  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    const sign = hash & 1 ? 1 : -1;
    vector[index] += sign;
  }
  const magnitude = Math.hypot(...vector) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function cosineSimilarity(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function lexicalOverlap(queryTokens, chunkTokens) {
  const chunkSet = new Set(chunkTokens);
  const matches = queryTokens.filter((token) => chunkSet.has(token)).length;
  return queryTokens.length === 0 ? 0 : matches / queryTokens.length;
}

function chunkText(text, { chunkWords = DEFAULT_CHUNK_WORDS, overlapWords = DEFAULT_OVERLAP_WORDS } = {}) {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const size = Math.max(20, Number(chunkWords) || DEFAULT_CHUNK_WORDS);
  const overlap = Math.min(Math.max(0, Number(overlapWords) || DEFAULT_OVERLAP_WORDS), size - 1);
  const step = size - overlap;
  const chunks = [];

  for (let start = 0; start < words.length; start += step) {
    const end = Math.min(start + size, words.length);
    chunks.push({ text: words.slice(start, end).join(" "), start_word: start, end_word: end });
    if (end === words.length) break;
  }
  return chunks;
}

function publicChunk(chunk, score = undefined) {
  const payload = {
    id: chunk.id,
    document_id: chunk.document_id,
    title: chunk.title,
    text: chunk.text,
    start_word: chunk.start_word,
    end_word: chunk.end_word,
    metadata: chunk.metadata,
  };
  if (score !== undefined) payload.score = Number(score.toFixed(4));
  return payload;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export function createRagStore({ dimensions = DEFAULT_DIMENSIONS } = {}) {
  const documents = new Map();
  const chunks = [];

  function ingest(input) {
    assertObject(input, "document");
    const text = normalizeText(input.text);
    if (!text) throw new RagError("invalid_document", "document.text is required");
    if (text.length > MAX_DOCUMENT_CHARS) {
      throw new RagError("document_too_large", `document.text must be ${MAX_DOCUMENT_CHARS} characters or fewer`, 413);
    }

    const id = normalizeText(input.id) || crypto.randomUUID();
    const title = normalizeText(input.title) || id;
    const metadata = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {};
    const documentChunks = chunkText(text, input.chunking);
    if (documents.has(id)) {
      for (let index = chunks.length - 1; index >= 0; index -= 1) {
        if (chunks[index].document_id === id) chunks.splice(index, 1);
      }
    }

    const storedDocument = {
      id,
      title,
      metadata,
      characters: text.length,
      chunks: documentChunks.length,
      created_at: new Date().toISOString(),
    };
    documents.set(id, storedDocument);

    documentChunks.forEach((chunk, index) => {
      const tokens = tokenize(chunk.text);
      chunks.push({
        ...chunk,
        id: `${id}#${index + 1}`,
        document_id: id,
        title,
        metadata,
        tokens,
        embedding: embedTokens(tokens, dimensions),
      });
    });

    return { ...storedDocument };
  }

  function listDocuments() {
    return [...documents.values()].map((document) => ({ ...document }));
  }

  function search(input) {
    assertObject(input, "search");
    const query = normalizeText(input.query);
    if (!query) throw new RagError("invalid_query", "query is required");
    const topK = Math.min(Math.max(1, Number(input.top_k) || 4), MAX_TOP_K);
    const filterDocumentId = input.document_id ? normalizeText(input.document_id) : "";
    const queryTokens = tokenize(query);
    const queryEmbedding = embedTokens(queryTokens, dimensions);

    const ranked = chunks
      .filter((chunk) => !filterDocumentId || chunk.document_id === filterDocumentId)
      .map((chunk) => {
        const semantic = cosineSimilarity(queryEmbedding, chunk.embedding);
        const lexical = lexicalOverlap(queryTokens, chunk.tokens);
        const score = semantic * 0.7 + lexical * 0.3;
        return { chunk, score };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
      .slice(0, topK);

    return {
      query,
      top_k: topK,
      indexed_documents: documents.size,
      indexed_chunks: chunks.length,
      matches: ranked.map((result) => publicChunk(result.chunk, result.score)),
    };
  }

  function buildContext(input) {
    const result = search(input);
    const context = result.matches
      .map((chunk, index) => `[${index + 1}] ${chunk.title} (${chunk.id})\n${chunk.text}`)
      .join("\n\n");
    return { ...result, context };
  }

  return {
    ingest,
    listDocuments,
    search,
    buildContext,
    stats() {
      return { documents: documents.size, chunks: chunks.length, embedding_dimensions: dimensions };
    },
  };
}

export function createGroundedRequest(request, ragResult) {
  const messages = Array.isArray(request.messages) ? [...request.messages] : [];
  const instruction = [
    "Use the retrieved context to answer the user's question.",
    "If the context does not contain enough evidence, say what is missing instead of guessing.",
    "Cite supporting chunks using bracket numbers such as [1] or [2].",
    "",
    ragResult.context || "No matching context was found.",
  ].join("\n");

  return {
    ...request,
    task: request.task || "question_answering",
    risk: request.risk || "medium",
    messages: [{ role: "system", content: instruction }, ...messages],
  };
}

export function latestUserQuery(messages) {
  const message = [...(messages || [])].reverse().find((item) => item?.role === "user");
  return normalizeText(messageText(message?.content));
}
