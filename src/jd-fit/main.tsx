// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GlobalWorkerOptions } from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import JdFitApp from "./JdFitApp.tsx";
import { initAnalytics, setAnalyticsSurface } from "../lib/analytics";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "../styles.css";

GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
setAnalyticsSurface("jd-fit");
void initAnalytics();

// Stale-deploy safety net (mirrors src/main.tsx). A tab loaded before a deploy
// holds the old jd-fit/index.html, whose hashed tier chunks are gone after the site
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
    <JdFitApp />
  </StrictMode>,
);
