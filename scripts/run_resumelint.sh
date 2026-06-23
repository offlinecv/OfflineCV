#!/usr/bin/env bash
set -euo pipefail

# resumelint — Local dev menu
#
# Usage:
#   Interactive: ./scripts/run_resumelint.sh
#   Commands:    ./scripts/run_resumelint.sh <command> [args]
#
# Commands:
#   dev           Start Vite dev server (http://localhost:5173)
#   build         Build static bundle into dist/
#   preview       Serve the built bundle (builds first if dist/ is missing)
#   test          Run vitest
#   test:watch    Run vitest in watch mode
#   typecheck     tsc -b --noEmit  (lint alias)
#   install       npm install
#   clean         Remove dist/ and node_modules/  (asks for confirmation)
#   eval:rewrite  Open the dev-only rewrite-quality eval page (#65). WebGPU required.
#   deploy        Build and deploy to GCS — forwards args to deploy_resumelint.sh
#                 (e.g.  ./scripts/run_resumelint.sh deploy --dry-run)

source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# common.sh resolves PROJECT_ROOT via `git rev-parse --show-toplevel`, which
# correctly returns the worktree root in linked worktrees too.
readonly WEB_DIR="$PROJECT_ROOT"
readonly DEV_PORT=5173
readonly DEPLOY_SCRIPT="$PROJECT_ROOT/scripts/deploy_resumelint.sh"

# =============================================================================
# COMMANDS (callable from CLI dispatch or the interactive menu)
# =============================================================================

cmd_dev() {
  log_info "Starting Vite dev server on http://localhost:$DEV_PORT"
  log_info "Ctrl+C to stop and return to the menu."
  npm_dev "$WEB_DIR"
}

cmd_build() {
  npm_build "$WEB_DIR"
}

cmd_preview() {
  log_info "Starting preview server. Ctrl+C to stop."
  npm_preview "$WEB_DIR"
}

cmd_test() {
  cd "$WEB_DIR"
  ensure_npm_deps "$WEB_DIR"
  log_info "Running vitest..."
  if npm test; then
    log_success "Tests passed"
  else
    log_error "Tests failed"
    return 1
  fi
}

cmd_test_watch() {
  cd "$WEB_DIR"
  ensure_npm_deps "$WEB_DIR"
  log_info "vitest --watch. Ctrl+C to stop."
  npm run test:watch
}

cmd_typecheck() {
  cd "$WEB_DIR"
  ensure_npm_deps "$WEB_DIR"
  log_info "Running typecheck (tsc -b --noEmit)..."
  if npm run typecheck; then
    log_success "Typecheck passed"
  else
    log_error "Typecheck failed"
    return 1
  fi
}

cmd_install() {
  npm_install "$WEB_DIR"
}

cmd_clean() {
  npm_clean "$WEB_DIR"
}

cmd_eval_rewrite() {
  cd "$WEB_DIR"
  ensure_npm_deps "$WEB_DIR"
  log_info "Opening rewrite-eval page on http://localhost:$DEV_PORT/resumelint/eval-rewrite.html"
  log_info "Ctrl+C to stop the dev server when done. WebGPU required to run inference."
  npm run eval:rewrite
}

cmd_deploy() {
  # Forward any remaining args (e.g. --dry-run, --mode=modified) verbatim.
  if [[ ! -x "$DEPLOY_SCRIPT" ]]; then
    log_error "$DEPLOY_SCRIPT not found or not executable"
    return 1
  fi
  log_info "Delegating to scripts/deploy_resumelint.sh..."
  "$DEPLOY_SCRIPT" "$@"
}

# =============================================================================
# INTERACTIVE MENU
# =============================================================================

print_menu() {
  echo -e "
${CYAN}============================================${NC}
${CYAN}   resumelint — Dev Menu${NC}
${CYAN}============================================${NC}
${BLUE}1)${NC} Dev server         (vite, port $DEV_PORT)
${BLUE}2)${NC} Build              (tsc -b && vite build → dist/)
${BLUE}3)${NC} Preview build      (vite preview)
${BLUE}4)${NC} Run tests          (vitest run)
${BLUE}5)${NC} Test watch         (vitest, watch mode)
${BLUE}6)${NC} Typecheck          (tsc -b --noEmit)
${BLUE}7)${NC} Install deps       (npm install)
${BLUE}e)${NC} Rewrite eval page  (dev-only, WebGPU; issue #65)
${BLUE}d)${NC} Deploy to GCS      (scripts/deploy_resumelint.sh)
${BLUE}p)${NC} Deploy --dry-run   (preview what would upload)
${BLUE}c)${NC} Clean              (rm -rf dist/ node_modules/)
${BLUE}0)${NC} Exit
${CYAN}============================================${NC}"
}

interactive_menu() {
  check_node_prereqs "$WEB_DIR"
  while true; do
    print_menu
    read -rp "Select an option: " choice
    echo ""
    # Long-running commands (1, 3, 5) return when the user hits Ctrl+C and
    # the menu then redraws — don't pause for Enter on those.
    case "${choice:-}" in
      1) cmd_dev || true ;;
      2) cmd_build || true ;;
      3) cmd_preview || true ;;
      4) cmd_test || true ;;
      5) cmd_test_watch || true ;;
      6) cmd_typecheck || true ;;
      7) cmd_install || true ;;
      e|E) cmd_eval_rewrite || true ;;
      d|D) cmd_deploy || true ;;
      p|P) cmd_deploy --dry-run || true ;;
      c|C) cmd_clean || true ;;
      0) log_success "Bye!"; exit 0 ;;
      *) log_error "Invalid option" ;;
    esac
    # Skip the Enter-prompt for foregrounded long-runners — they already
    # blocked until the user was ready to come back.
    if [[ ! "$choice" =~ ^[135]$ ]] && [[ "${choice:-}" != "p" ]] && [[ "${choice:-}" != "P" ]] && [[ "${choice:-}" != "e" ]] && [[ "${choice:-}" != "E" ]]; then
      echo ""
      read -rp "Press Enter to continue..."
    fi
  done
}

# =============================================================================
# CLI DISPATCH
# =============================================================================

if [[ $# -eq 0 ]]; then
  interactive_menu
else
  subcommand="$1"
  shift
  case "$subcommand" in
    dev)          cmd_dev ;;
    build)        cmd_build ;;
    preview)      cmd_preview ;;
    test)         cmd_test ;;
    test:watch|test-watch) cmd_test_watch ;;
    typecheck|lint) cmd_typecheck ;;
    install)      cmd_install ;;
    clean)        cmd_clean ;;
    eval:rewrite|eval-rewrite) cmd_eval_rewrite ;;
    deploy)       cmd_deploy "$@" ;;
    -h|--help|help)
      sed -n '3,21p' "${BASH_SOURCE[0]}"
      ;;
    *)
      log_error "Unknown command: $subcommand"
      echo "Usage: $0 [dev|build|preview|test|test:watch|typecheck|install|clean|eval:rewrite|deploy [args...]]"
      echo "       $0          (interactive menu)"
      exit 1
      ;;
  esac
fi
