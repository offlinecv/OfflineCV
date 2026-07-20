#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The offlinecv Authors
"""PostToolUse(Edit|Write) convention check for offlinecv.

Fires after a .ts / .tsx file under ``src/`` is edited. Fails (exit 2
with a clear message) when the change introduces a known anti-pattern.

Checks:
1. SPDX header — every ``src/**/*.{ts,tsx}`` file carries the 3-line
   Apache-2.0 SPDX block (CLAUDE.md "Exemplars").
2. Copy discipline — forbid ``exactly`` / ``precisely`` in user-facing
   files (``src/App.tsx`` and ``src/components/``). Our parser doesn't
   see what an ATS sees; promising precision misrepresents the tool.
   Memory: feedback_no_false_precision_in_parser_copy.
3. PostHog scope — ``posthog-js`` may only be imported in
   ``src/lib/analytics.ts``. The build-time ``VITE_POSTHOG_KEY`` gate
   only dead-code-eliminates the SDK when every touchpoint funnels
   through that single file. Memory: pattern_env_gated_oss_telemetry.
4. Tier discipline — only ``src/lib/heuristics/cascade.ts`` (and
   ``*.test.ts`` files) may import the tier modules ``pdf-extract``,
   ``openresume``, or ``regex-fallback``. Production code goes through
   ``runCascade()``. CLAUDE.md "Pipeline shape".
5. No raw ``console.log`` in ``src/lib/``. Easy to slip in during
   debugging, would ship in the OSS bundle.

Override for one tool call: ``OFFLINECV_SKIP_HOOKS=1``.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HOOK_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(HOOK_DIR))
from _hooklib import fail, load_payload, maybe_skip, tool_file_path  # noqa: E402

REPO_ROOT = HOOK_DIR.parent.parent
SRC = REPO_ROOT / "src"
PREFIX = "offlinecv convention check"

SPDX_HEADER = (
    "// SPDX-License-Identifier: Apache-2.0\n"
    "// Copyright 2026 The offlinecv Authors\n"
)
USER_FACING_TOP = {"App.tsx", "components"}
TIER_MODULES = ("pdf-extract", "openresume", "regex-fallback")
CASCADE_REL = "lib/heuristics/cascade.ts"


def strip_line_comments(src: str) -> str:
    """Drop // single-line comments. Block comments stay (they often
    wrap JSX literals, and our policy applies to those too)."""
    return re.sub(r"//[^\n]*", "", src)


def main() -> None:
    maybe_skip()
    payload = load_payload()
    file_path = tool_file_path(payload)
    if not file_path:
        return

    fp = Path(file_path)
    if fp.suffix not in {".ts", ".tsx"}:
        return
    try:
        rel = fp.resolve().relative_to(SRC)
    except ValueError:
        return  # not under src/

    try:
        contents = fp.read_text()
    except FileNotFoundError:
        return

    rel_str = str(rel)
    is_test = ".test." in fp.name

    # 1: SPDX header on non-test source files. (Test files inherit
    # licensing from the package; the 3-line block is for distributed
    # source.)
    if not is_test and not contents.startswith(SPDX_HEADER):
        fail(
            PREFIX,
            f"`src/{rel_str}` is missing the SPDX header. Prepend:\n"
            f"{SPDX_HEADER}"
            f"\nSee CLAUDE.md \"Exemplars\"; license rationale in "
            f"docs/CONTRIBUTING-PROCESS.md.",
        )

    # 2: copy discipline — no "exactly" / "precisely" in user-facing files.
    if rel.parts[0] in USER_FACING_TOP and not is_test:
        scan = strip_line_comments(contents)
        m = re.search(r"\b(exactly|precisely)\b", scan, re.IGNORECASE)
        if m:
            fail(
                PREFIX,
                f"`src/{rel_str}` uses \"{m.group(1)}\" in user-facing copy. "
                f"Our parser doesn't see what an ATS sees — promising "
                f"precision misrepresents the tool. Memory: "
                f"feedback_no_false_precision_in_parser_copy.",
            )

    # 3: PostHog scope — analytics.ts only.
    if rel_str != "lib/analytics.ts":
        if re.search(r'["\']posthog-js["\']', contents):
            fail(
                PREFIX,
                f"`src/{rel_str}` imports posthog-js. The build-time env "
                f"gate only works if every touchpoint goes through "
                f"`src/lib/analytics.ts` — call the helpers there instead. "
                f"Memory: pattern_env_gated_oss_telemetry.",
            )

    # 4: tier discipline. Only cascade.ts (and *.test.ts files) may name
    # the tier modules in an import. Production code calls runCascade.
    if rel_str != CASCADE_REL and not is_test:
        for mod in TIER_MODULES:
            # Match the bare module token in any import shape:
            #   import … from "./pdf-extract"
            #   await import("./pdf-extract.ts")
            pat = rf'["\'][./]*{re.escape(mod)}(\.ts)?["\']'
            if re.search(pat, contents):
                fail(
                    PREFIX,
                    f"`src/{rel_str}` imports tier module `{mod}` directly. "
                    f"Only `src/{CASCADE_REL}` may name tier modules; "
                    f"production code calls `runCascade()`. "
                    f"See CLAUDE.md \"Pipeline shape\".",
                )

    # 5: no raw console.log in src/lib/.
    if rel.parts[0] == "lib" and not is_test:
        scan = strip_line_comments(contents)
        if re.search(r"\bconsole\.log\s*\(", scan):
            fail(
                PREFIX,
                f"`src/{rel_str}` contains a raw `console.log(`. "
                f"Remove debug logging before commit; use the analytics "
                f"layer for telemetry.",
            )


if __name__ == "__main__":
    main()
