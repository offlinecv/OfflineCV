// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GlobalWorkerOptions } from "pdfjs-dist";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import App from "./App";
import { initAnalytics } from "./lib/analytics";
import "./styles.css";

GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
void initAnalytics();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
