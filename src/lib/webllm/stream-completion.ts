// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * streamCompletion — shared streaming + cancellation wrapper for the two long
 * inferences behind "Local AI feedback" (#1095): `analyzeResumeWithLlm` and
 * `critiqueResumeWithLlm`. Both used one non-streaming
 * `engine.chat.completions.create()` call with no progress signal and no way
 * to cancel — on a memory-constrained device the panel could sit on
 * "Analyzing…" for ten-plus minutes with nothing to show for it.
 *
 * `WebLlmEngine.chat.completions.create()`'s declared return type stays the
 * non-streaming `ChatCompletionResponse` for every OTHER call site (rewrite,
 * parse, jd-match) — changing it to a union would force each of them to
 * narrow a type they never asked for. This module passes `stream: true` and
 * asserts the WebLLM-documented streaming shape at the one call site that
 * uses it; a runtime guard (`isAsyncIterable`) tells a real/stub stream apart
 * from a stub that ignores `stream` and returns the plain response — the
 * latter degrades to reading `.choices[0].message.content` directly, so
 * every engine stub written before #1095 keeps working unmodified.
 *
 * Cancellation is BOUNDARY-based, same reasoning as `jd-match/llm/abort.ts`:
 * the real engine's `interruptGenerate()` is engine-scoped, not
 * request-scoped, so calling it would also kill any OTHER concurrent
 * caller's inference on the same shared model (#148) — the shipped model is
 * the one instance every WebLLM feature on the page acquires. We only stop
 * CONSUMING our own stream: checked before the call, raced against every
 * `iterator.next()` so a stalled chunk can't block cancellation, and after
 * each chunk. An already-dispatched generation may keep running in the
 * background after we walk away from it; the caller's `finally` still
 * releases the #148 inference lock either way, and the wasted compute is the
 * same bounded trade-off `jd-match/llm/abort.ts` documents. The abort error
 * this module throws is a fetch-standard `DOMException` named `"AbortError"`
 * — shape-identical to that module's, not imported from it, since
 * `jd-match/` sits downstream of `webllm/` and importing back would invert
 * the dependency.
 */

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  WebLlmEngine,
} from "./types.ts";

function isAsyncIterable(
  value: unknown,
): value is AsyncIterable<ChatCompletionChunk> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] ===
      "function"
  );
}

/**
 * `onTokens` drives a React `setStatus` call — reporting every chunk means
 * up to ~3072 re-renders per phase on the memory-constrained devices this
 * feature targets. Report the first token immediately (so the UI shows
 * progress right away), then every Nth token, plus a final flush so the
 * caller always sees the true count.
 */
const TOKEN_PROGRESS_STRIDE = 16;

function streamAbortError(): DOMException {
  return new DOMException("Analysis aborted.", "AbortError");
}

/** Rejects the instant `signal` aborts; never settles otherwise. */
function whenAborted(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) return new Promise<never>(() => {});
  if (signal.aborted) return Promise.reject(streamAbortError());
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(streamAbortError()), {
      once: true,
    });
  });
}

export interface StreamCompletionOptions {
  signal?: AbortSignal;
  /**
   * Cumulative token count so far: the first token, then every
   * `TOKEN_PROGRESS_STRIDE` tokens, plus a final flush — not once per chunk.
   */
  onTokens?: (tokens: number) => void;
}

/**
 * Consumes an already-opened chunk stream, racing each `iterator.next()`
 * against abort the same way the initial `create()` call is raced — split
 * out of `streamCompletion` so the loop's own branching doesn't compound
 * with the response-shape branching around it.
 */
async function consumeStream(
  iterator: AsyncIterator<ChatCompletionChunk>,
  signal: AbortSignal | undefined,
  onTokens: ((tokens: number) => void) | undefined,
): Promise<string> {
  let text = "";
  let tokens = 0;
  let reported = 0;
  const aborted = whenAborted(signal);
  try {
    for (;;) {
      const step = await Promise.race([iterator.next(), aborted]);
      if (step.done) break;
      const delta = step.value.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        tokens += 1;
        // Report the first token immediately (so an early Stop still shows
        // up), then throttle — see `TOKEN_PROGRESS_STRIDE`.
        if (tokens === 1 || tokens - reported >= TOKEN_PROGRESS_STRIDE) {
          onTokens?.(tokens);
          reported = tokens;
        }
      }
      if (signal?.aborted) throw streamAbortError();
    }
  } catch (err) {
    void iterator.return?.()?.catch(() => {});
    throw err;
  }
  if (reported !== tokens) onTokens?.(tokens);
  return text;
}

/**
 * Run one streamed completion, returning the fully-accumulated text.
 *
 * Racing the initial `create()` call against `signal` is what lets a stub
 * engine that never resolves (the shape a per-phase-deadline test uses)
 * still unblock the caller the instant it's aborted — awaiting `create()`
 * directly would hang until the stub resolves, which is never. Each
 * subsequent `iterator.next()` is raced the same way (see `consumeStream`),
 * so a stalled chunk (a memory-constrained device swapping mid-generation,
 * #1095) can't block Stop or the per-phase deadline either; on abort we call
 * `iterator.return()` best-effort so the underlying stream gets a chance to
 * clean up.
 *
 * Throws whatever `create()` throws, PLUS the `AbortError` above when
 * `signal` fires. The caller tells the two apart via `signal.aborted`, not
 * error identity — see `analyzeResumeWithLlm` / `critiqueResumeWithLlm`.
 */
export async function streamCompletion(
  engine: WebLlmEngine,
  messages: ChatMessage[],
  maxTokens: number,
  opts: StreamCompletionOptions = {},
): Promise<string> {
  const { signal, onTokens } = opts;
  if (signal?.aborted) throw streamAbortError();

  const raw = await Promise.race([
    engine.chat.completions.create({
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      stream: true,
    }),
    whenAborted(signal),
  ]);
  // See the module docblock: the declared return type is the non-streaming
  // shape for every other call site's sake; narrow to what `stream: true`
  // actually yields at runtime.
  const response = raw as unknown as
    | ChatCompletionResponse
    | AsyncIterable<ChatCompletionChunk>;

  if (!isAsyncIterable(response)) {
    return response.choices[0]?.message?.content ?? "";
  }

  return consumeStream(response[Symbol.asyncIterator](), signal, onTokens);
}
