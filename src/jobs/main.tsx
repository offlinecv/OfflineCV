// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import JobsApp from "./JobsApp.tsx";
import { initAnalytics, setAnalyticsSurface } from "../lib/analytics";
import { scheduleRetiredModelCleanup } from "../lib/webllm/retired-models";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "../styles.css";

// No pdfjs worker configuration here (unlike src/main.tsx): this surface never
// parses a PDF — it receives an already-parsed résumé through the sessionStorage
// handoff — so importing pdfjs would pull a large chunk into the entry for
// nothing.
setAnalyticsSurface("jobs");
void initAnalytics();
// One-time removal of the retired picker models' weights and keys (#1015).
// Idle-scheduled, and a Cache API read that needs no web-llm import or
// network request, so it never competes with first paint.
scheduleRetiredModelCleanup();

// Stale-deploy safety net (mirrors src/main.tsx). A tab loaded before a deploy
// holds the old jobs/index.html, whose hashed tier chunks are gone after the site
// snapshot is replaced. The failing import fires `vite:preloadError`; reload
// pulls the fresh build. The sessionStorage guard prevents a reload loop.
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("vite-preload-reloaded")) return;
  sessionStorage.setItem("vite-preload-reloaded", "1");
  window.location.reload();
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <JobsApp />
  </StrictMode>,
);
