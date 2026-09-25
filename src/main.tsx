// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GlobalWorkerOptions } from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import App from "./App";
import { initAnalytics, setAnalyticsSurface } from "./lib/analytics";
import { scheduleRetiredModelCleanup } from "./lib/webllm/retired-models";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "./styles.css";

GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
setAnalyticsSurface("parser");
void initAnalytics();
// One-time removal of the retired picker models' weights and keys (#1015).
// Idle-scheduled, and a Cache API read that needs no web-llm import or
// network request, so it never competes with first paint.
scheduleRetiredModelCleanup();

// Stale-deploy safety net. A tab loaded before a deploy holds the old
// index.html, whose hashed tier chunks (dynamic-imported in cascade.ts) are
// gone after a GitHub Pages deploy replaces the site snapshot. The failing
// import fires `vite:preloadError`; reload pulls the fresh, self-consistent
// build. The sessionStorage guard prevents a reload loop if the chunk is
// genuinely unrecoverable. This is the hard-failure backstop; proactive
// version detection lives in the update-checker (see useUpdateChecker).
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("vite-preload-reloaded")) return;
  sessionStorage.setItem("vite-preload-reloaded", "1");
  window.location.reload();
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
