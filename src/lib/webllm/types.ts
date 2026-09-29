// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * WebGPU detection outcome. `"available"` is the only branch that lights up
 * the rewrite button — the other three collapse to the same UI behavior (hide
 * the CTA, show `WebGpuUnavailableNotice`) but stay distinct in telemetry so
 * we can tell "device has no GPU driver" from "browser doesn't ship WebGPU
 * yet" from "GPU lacks the shader precision the shipped model needs" (#1019).
 */
export type WebGpuCapability =
  | "available"
  | "no-webgpu"
  | "unsupported-os"
  | "no-shader-f16";

export interface ProgressUpdate {
  /** 0..1 fraction reported by WebLLM's loader. */
  progress: number;
  /** Human-readable status from WebLLM (e.g. weight file being fetched). */
  text: string;
  /**
   * Where the weights are coming from, as `loadEngine` found them before it
   * started (#1015): `"device"` when every shard was already in Cache
   * Storage, `"network"` otherwise. Absent until that probe has answered, so
   * a label must read "absent" as "not known yet", never as either side.
   */
  source?: ModelLoadSource;
}

export type ModelLoadSource = "device" | "network";

/**
 * Narrow contract over `@mlc-ai/web-llm`'s engine — only the surface
 * `rewriteBulletWithLlm` consumes. Keeping this thin lets tests pass a stub
 * without importing the real library (and keeps the type graph small).
 */
export interface WebLlmEngine {
  chat: {
    completions: {
      create: (req: ChatCompletionRequest) => Promise<ChatCompletionResponse>;
    };
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Which half of `useResumeAnalysisLlm`'s combined run is in flight (#1095):
 * `"parse"` is `analyzeResumeWithLlm`, `"critique"` is `critiqueResumeWithLlm`.
 * Shared here (not defined in the hook) because `streamCompletion`'s two
 * callers each stamp their own phase onto the progress they report.
 */
export type AnalysisPhase = "parse" | "critique";

/** A running token-count update from one of the two analysis passes. */
export interface AnalysisProgressInfo {
  /** Cumulative tokens streamed so far in this phase. */
  tokens: number;
  phase: AnalysisPhase;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  /**
   * Requests a streamed response (issue #1095). `WebLlmEngine.create()`'s
   * declared return type stays the non-streaming `ChatCompletionResponse`
   * below for every call site that doesn't set this — see the docblock on
   * `streamCompletion` in `stream-completion.ts`, the one place that passes
   * `stream: true` and narrows the real runtime shape itself.
   */
  stream?: boolean;
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
}

/** One streamed chunk of a `stream: true` completion. */
export interface ChatCompletionChunk {
  choices: Array<{ delta: { content?: string | null } }>;
}
