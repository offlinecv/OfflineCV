#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The offlinecv Authors
"""Shared helpers for offlinecv Claude Code hooks written in Python.

Each hook reads a JSON payload from stdin describing the tool call.
Convention checks fail with ``fail()`` (exit 2) so the parent tool call
is blocked; advisory hooks (warnings, reminders) exit 0.

Bypass for one tool call: ``OFFLINECV_SKIP_HOOKS=1``.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any

SKIP_ENV = "OFFLINECV_SKIP_HOOKS"


def maybe_skip() -> None:
    """Exit 0 if the user requested a bypass for this tool call."""
    if os.environ.get(SKIP_ENV) == "1":
        sys.exit(0)


def load_payload() -> dict[str, Any]:
    """Parse the hook stdin payload. Returns {} on any failure."""
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def tool_file_path(payload: dict[str, Any]) -> str:
    return (payload.get("tool_input") or {}).get("file_path", "") or ""


def fail(prefix: str, msg: str) -> None:
    sys.stderr.write(f"{prefix}: {msg}\n")
    sys.stderr.write(f"Override for one call: {SKIP_ENV}=1.\n")
    sys.exit(2)
