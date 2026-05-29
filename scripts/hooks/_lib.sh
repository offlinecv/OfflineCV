# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The resumelint Authors
#
# Shared helper for resumelint Claude Code hooks. Sourced by every *.sh
# hook in this directory. No shebang — this file is sourced, not executed.
#
# Each hook receives a JSON payload on stdin describing the tool call
# that triggered it (Claude Code passes things like `session_id`,
# `tool_name`, `tool_input.file_path`, `tool_input.command`).
#
# Single function exposed:
#
#   hook_input_field <payload> <dotted.path>
#
# Returns the field at the dotted path, or empty string if missing or
# malformed. Hooks treat empty as "nothing to do" and exit 0.
#
# Example:
#
#   input="$(cat)"
#   file_path="$(hook_input_field "$input" tool_input.file_path)"
#   session_id="$(hook_input_field "$input" session_id)"
#
# The single-helper shape is intentional: every hook needs exactly this
# operation, and pulling it here means hooks read top-to-bottom as
# *what they do*, not *how to parse JSON in bash*.

hook_input_field() {
  local payload="$1"
  local path="$2"
  printf '%s' "$payload" | RESUMELINT_HOOK_FIELD="$path" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for part in os.environ["RESUMELINT_HOOK_FIELD"].split("."):
    if not isinstance(d, dict):
        sys.exit(0)
    d = d.get(part)
    if d is None:
        sys.exit(0)
print(d if isinstance(d, str) else json.dumps(d))
'
}
