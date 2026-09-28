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
4. Tier discipline — only ``src/lib/heuristics/cascade.ts`` (plus
   ``*.test.ts`` files and anything under a ``__test-utils__/``
   directory) may import the tier modules ``pdf-extract``,
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


def strip_comments(src: str) -> str:
    """Drop both // line comments and /* */ block comments before a
    copy-discipline regex scan, so a word inside a docblock (prose
    *about* the rule) can't trip a check meant to police JSX/string
    literals. See #969: a `/* */` docblock's "exactly" fired check 2
    on every edit to a file that doesn't contain the pattern it exists
    to catch.

    Walks the source char-by-char instead of using a single alternation
    regex:

    - A bare `/*`-shaped sequence inside a string/template literal
      (e.g. ``"a/*b"``) is not a comment start — matching it as one
      swallows everything up to the next unrelated `*/`, hiding real
      content (like a later JSX "precisely") from checks 2 and 5. String
      and template-literal spans are copied through untouched; only
      text outside them is scanned for comment markers.
    - A `${…}` interpolation inside a template literal is live code, not
      string text, and can itself hold a nested template literal (see
      `canonicalJobUrl` in `job-url.ts`) or an object literal — so
      template/brace nesting is tracked with an explicit stack rather
      than "read until the next backtick", which closes on a *nested*
      literal's opening backtick and desyncs every quote after it.
    - A `//` immediately preceded by a backslash is the second slash of
      an escaped `\\/` inside a regex literal (`/^https?:\\/\\//i`), not
      a comment start; matching it as one would drop the rest of that
      line from checks 2 and 5.
    - An unterminated `/*` is invalid JS; keep the tail as ordinary text
      instead of silently dropping it from the scan.
    """
    out = []
    i, n = 0, len(src)
    # 'template': raw template-literal text (a bare backtick closes it).
    # 'brace': live code inside a `${…}` interpolation, or a nested `{…}`
    # within one — tracked so its closing `}` doesn't get mistaken for
    # the interpolation's end.
    stack: list[str] = []
    while i < n:
        if stack and stack[-1] == "template":
            c = src[i]
            if c == "\\":
                out.append(c)
                i += 1
                if i < n:
                    out.append(src[i])
                    i += 1
                continue
            if c == "`":
                out.append(c)
                i += 1
                stack.pop()
                continue
            if src[i : i + 2] == "${":
                out.append("${")
                i += 2
                stack.append("brace")
                continue
            out.append(c)
            i += 1
            continue
        two = src[i : i + 2]
        if two == "//" and not (i > 0 and src[i - 1] == "\\"):
            j = src.find("\n", i)
            i = n if j == -1 else j
            continue
        if two == "/*":
            j = src.find("*/", i + 2)
            if j == -1:
                out.append(src[i:])
                i = n
            else:
                i = j + 2
            continue
        ch = src[i]
        if ch in ("'", '"'):
            out.append(ch)
            i += 1
            while i < n:
                c = src[i]
                out.append(c)
                i += 1
                if c == "\\":
                    if i < n:
                        out.append(src[i])
                        i += 1
                    continue
                if c == ch:
                    break
            continue
        if ch == "`":
            out.append(ch)
            i += 1
            stack.append("template")
            continue
        if stack and stack[-1] == "brace":
            if ch == "{":
                out.append(ch)
                i += 1
                stack.append("brace")
                continue
            if ch == "}":
                out.append(ch)
                i += 1
                stack.pop()
                continue
        out.append(ch)
        i += 1
    return "".join(out)


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
    # Test-only, but not a test *file*: helpers under `__test-utils__/`. The
    # repo already treats that directory as non-production (vite.config.ts
    # drops `src/**/__test-utils__/**` from coverage), and #829 put a real
    # consumer there — the aliased stand-in for `pdf-extract.ts`, which has to
    # name the tier module it wraps. Rule 4 below exempts it for that reason;
    # the SPDX rule deliberately does not, since these files still ship in the
    # OSS tree.
    is_test_only = is_test or "__test-utils__" in rel.parts

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
        scan = strip_comments(contents)
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

    # 4: tier discipline. Only cascade.ts (and test-only code) may name
    # the tier modules in an import. Production code calls runCascade.
    if rel_str != CASCADE_REL and not is_test_only:
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
        scan = strip_comments(contents)
        if re.search(r"\bconsole\.log\s*\(", scan):
            fail(
                PREFIX,
                f"`src/{rel_str}` contains a raw `console.log(`. "
                f"Remove debug logging before commit; use the analytics "
                f"layer for telemetry.",
            )


if __name__ == "__main__":
    main()
