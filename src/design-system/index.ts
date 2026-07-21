// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Design-system barrel — the `@design-system` seam.
 *
 * Feature code imports primitives and shared-composed components from here
 * (`import { Button, Card } from "@design-system"`), never via deep relative
 * paths into primitives/ or shared/. A downstream productionizer repoints the
 * `@design-system` Vite alias (+ tsconfig `paths`) at their own module that
 * re-exports the same primitive API — swapping the whole component layer
 * without forking. The token VALUES swap separately via the `@design-tokens`
 * alias (see styles/tokens.css); the semantic vocabulary (styles/theme.css)
 * is the stable contract both layers share. See the README "Theming" section.
 */

export * from "./icons/TrustIcons.tsx";
export * from "./primitives/Button.tsx";
export * from "./primitives/Chip.tsx";
export * from "./primitives/Dialog.tsx";
export * from "./primitives/EditableField.tsx";
export * from "./primitives/StarRating.tsx";
export * from "./primitives/TextAreaField.tsx";
export * from "./shared/CapabilityStrip.tsx";
export * from "./shared/Card.tsx";
export * from "./shared/InlineResult.tsx";
export * from "./shared/ModelLoadProgress.tsx";
export * from "./shared/StatusBadge.tsx";
export * from "./shared/Tabs.tsx";
export * from "./shared/CountBadge.tsx";
export * from "./shared/ErrorState.tsx";
export * from "./shared/ErrorBoundary.tsx";
export * from "./shared/UpdateBanner.tsx";
export * from "./shared/GitHubStarCta.tsx";
export * from "./shared/InlineDiff.tsx";
