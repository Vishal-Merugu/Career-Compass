import { AppError } from '../errors/AppError.js';
import { logger } from '../lib/logger.js';
import {
  getBaseUrl,
  getHeaders,
  normalizeProvider,
  resolveModel,
  usesOllamaDialect,
} from '../shared/llmClient.js';
import { IUserConfig } from '../shared/types.js';

/**
 * Streaming counterpart to `sendChatCompletion`.
 *
 * Server-only on purpose. `shared/llmClient.ts` is hand-mirrored into
 * `extension/services/llmClient.js`, so anything living there has to survive
 * being copied into a file with no imports; this needs `AppError`, and the
 * extension has no use for a token stream.
 *
 * It also deliberately does **not** retry. `sendChatCompletion` retries a
 * timeout because nothing has been observed yet. Here the caller has already
 * been handed tokens, so a second attempt would append a fresh draft onto a
 * partial one. A stream that breaks mid-way is an error the caller reports.
 */

class LlmStreamError extends AppError {
  constructor(message: string) {
    super(message, 502);
  }
}

/**
 * Split a byte stream into complete lines.
 *
 * Both wire formats below are line-delimited, and a network chunk bears no
 * relationship to a line: one `read()` can carry half a JSON object, or three
 * objects and a fragment. Parsing per-chunk drops tokens silently — the text
 * still reads as plausible English, which is why this has to buffer rather
 * than split each chunk.
 */
export async function* readLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        yield buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer.replace(/\r$/, '');
  } finally {
    reader.releaseLock();
  }
}

/** `message.content` (Ollama) or `choices[0].delta.content` (OpenAI). */
export function extractDelta(payload: unknown, ollama: boolean): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const obj = payload as Record<string, unknown>;

  if (ollama) {
    const message = obj.message;
    if (typeof message !== 'object' || message === null) return '';
    const content = (message as Record<string, unknown>).content;
    return typeof content === 'string' ? content : '';
  }

  const choices = obj.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first: unknown = choices[0];
  if (typeof first !== 'object' || first === null) return '';
  const delta = (first as Record<string, unknown>).delta;
  if (typeof delta !== 'object' || delta === null) return '';
  const content = (delta as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

/**
 * Yield the model's output as it is written.
 *
 * `signal` is not optional: without it an abandoned browser tab leaves the
 * request to the model running to completion, and a local Ollama serves one
 * request at a time.
 */
export async function* streamChatCompletion(
  config: IUserConfig,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number,
  temperature: number,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const provider = normalizeProvider(config);
  // The built-in provider speaks Ollama's dialect too — miss this and a new
  // account, which defaults to it, streams OpenAI-shaped frames at `/api/chat`.
  const isOllama = usesOllamaDialect(provider);
  const baseUrl = getBaseUrl(config);
  const headers = getHeaders(config);
  const model = resolveModel(config);

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const endpoint = isOllama
    ? `${baseUrl}/api/chat`
    : `${baseUrl}/chat/completions`;
  const body = isOllama
    ? JSON.stringify({
        model,
        messages,
        stream: true,
        options: { num_predict: maxTokens, temperature },
      })
    : JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      });

  const res = await fetch(endpoint, { method: 'POST', headers, body, signal });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LlmStreamError(`LLM error ${res.status}: ${text.slice(0, 150)}`);
  }
  if (!res.body) {
    throw new LlmStreamError('LLM returned no response body');
  }

  for await (const line of readLines(res.body)) {
    if (line.length === 0) continue;

    // Ollama answers in NDJSON. Every OpenAI-compatible provider answers in
    // SSE, where non-`data:` lines (`event:`, `id:`, `:` comments) are framing
    // and must be skipped rather than parsed.
    let json = line;
    if (!isOllama) {
      if (!line.startsWith('data:')) continue;
      json = line.slice(5).trim();
      if (json === '[DONE]') return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      // One malformed frame is not worth discarding a half-written draft.
      logger.warn(`[LLM] unparseable stream frame: ${json.slice(0, 120)}`);
      continue;
    }

    const delta = extractDelta(payload, isOllama);
    if (delta) yield delta;

    if (isOllama && (payload as Record<string, unknown>).done === true) return;
  }
}
