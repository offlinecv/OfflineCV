// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * WebGPU detection outcome. `"available"` is the only branch that lights up
 * the rewrite button — the other two collapse to the same UI behavior (hide
 * the CTA) but stay distinct in telemetry so we can tell "device has no GPU
 * driver" from "browser doesn't ship WebGPU yet."
 */
export type WebGpuCapability = "available" | "no-webgpu" | "unsupported-os";

export interface ProgressUpdate {
  /** 0..1 fraction reported by WebLLM's loader. */
  progress: number;
  /** Human-readable status from WebLLM (e.g. weight file being fetched). */
  text: string;
}

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

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
}
