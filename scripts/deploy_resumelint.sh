#!/bin/bash

# resumelint — Build and deploy the static bundle to a GCS bucket.
#
# Reads PROJECT_ID and BUCKET_NAME from .env.deploy (gitignored) or the
# --project= / --bucket= flags. No recruidea defaults are baked in, so OSS
# forks can point this at their own bucket without editing the script.
#
# If .env.deploy sets VITE_POSTHOG_KEY (and optionally VITE_POSTHOG_HOST),
# the build is instrumented per src/lib/analytics.ts. With those unset, the
# OSS no-analytics build is produced (PostHog import is dead-code-eliminated).
#
# Usage: ./scripts/deploy_resumelint.sh [options]
#
# A sibling script (scripts/deploy_resumelint_<target>.sh) should be added
# rather than a --target flag when a second host emerges.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Shared deployment helpers (symlink to ~/tools/scripts/deploy_web_utils.sh).
# Provides check_prerequisites, set_gcloud_project, deploy_all_files,
# deploy_modified_files, get_modified_files, execute_with_error_check,
# DRY_RUN, and the GSUTIL_BIN macOS-multiprocessing wrapper.
source "$SCRIPT_DIR/deploy_web_utils.sh"

# Portable .env loader from ~/tools/scripts/. Provides load_env_file, which
# validates keys, strips surrounding quotes, and skips assignments that are
# already set in the environment (so an existing shell var wins over the
# file, and CLI flags below win over both).
source "$SCRIPT_DIR/load_env.sh"
load_env_file "$PROJ_ROOT/.env.deploy" || true

# --- Parse arguments (override anything from .env.deploy) ---
DEPLOY_MODE="${DEPLOY_MODE:-all}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --project=*)
      PROJECT_ID="${1#*=}"
      shift
      ;;
    --bucket=*)
      BUCKET_NAME="${1#*=}"
      shift
      ;;
    --mode=*)
      DEPLOY_MODE="${1#*=}"
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      echo -e "${BLUE}resumelint deploy${NC}"
      echo "Usage: $0 [options]"
      echo ""
      echo "Reads PROJECT_ID and BUCKET_NAME from .env.deploy (gitignored) or flags."
      echo ""
      echo "Options:"
      echo "  --project=ID      GCP project ID (overrides .env.deploy)"
      echo "  --bucket=NAME     GCS bucket name (overrides .env.deploy)"
      echo "  --mode=MODE       Deployment mode: all (default), modified"
      echo "  --skip-build      Skip npm build (deploy existing dist/)"
      echo "  --dry-run         Print commands without uploading"
      echo "  --help            Show this help"
      echo ""
      echo "Examples:"
      echo "  $0                              # Build and deploy everything"
      echo "  $0 --dry-run                    # Preview without uploading"
      echo "  $0 --mode=modified --skip-build # Re-deploy changed files only"
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      echo "Use --help for usage information."
      exit 1
      ;;
  esac
done

: "${PROJECT_ID:?Set PROJECT_ID in .env.deploy or pass --project=}"
: "${BUCKET_NAME:?Set BUCKET_NAME in .env.deploy or pass --bucket=}"

BUILD_DIR="$PROJ_ROOT/dist"

# --- Prerequisites ---
check_prerequisites

# --- Build ---
if [ "$SKIP_BUILD" != true ]; then
  echo -e "${BLUE}Building resumelint...${NC}"
  cd "$PROJ_ROOT"
  npm run build
  echo ""
fi

if [ ! -d "$BUILD_DIR" ]; then
  echo -e "${RED}ERROR: dist/ not found at $BUILD_DIR. Run without --skip-build or run npm run build first.${NC}"
  exit 1
fi

echo -e "${BLUE}Starting resumelint deployment...${NC}"
echo "Project:  $PROJECT_ID"
echo "Bucket:   $BUCKET_NAME"
echo "Source:   $BUILD_DIR"
echo "Mode:     $DEPLOY_MODE"
if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}[DRY RUN MODE]${NC}"
fi
echo ""

# --- Set GCP project ---
set_gcloud_project "$PROJECT_ID"

# --- Deploy ---
echo -e "\n${BLUE}━━━ Deploying to $BUCKET_NAME ━━━${NC}"

case "$DEPLOY_MODE" in
  "all")
    deploy_all_files "$BUILD_DIR" "$BUCKET_NAME"
    ;;
  "modified")
    modified_list=$(get_modified_files "$BUILD_DIR")
    deploy_modified_files "$BUILD_DIR" "$BUCKET_NAME" "$modified_list"
    ;;
  *)
    echo -e "${RED}ERROR: Unknown mode '$DEPLOY_MODE'. Use: all, modified${NC}"
    exit 1
    ;;
esac

# --- Content types and cache headers ---
# Sets per-extension content types and cache headers, plus a wasm rule for the
# pdfjs worker if it lands in dist/assets/.
echo -e "${BLUE}Setting content types and cache headers...${NC}"

HTML_FILES=$(cd "$BUILD_DIR" && find . -name "*.html" | sed 's|^\./||' | while read -r f; do echo "gs://$BUCKET_NAME/$f"; done | tr '\n' ' ')
if [ -n "$HTML_FILES" ]; then
  execute_with_error_check "gsutil -m setmeta -h 'Content-Type:text/html' $HTML_FILES" "Set Content-Type for HTML files"
  execute_with_error_check "gsutil -m setmeta -h 'Cache-Control:no-cache, no-store, must-revalidate' $HTML_FILES" "Set Cache-Control for HTML files (no-cache)"
fi

CSS_FILES=$(cd "$BUILD_DIR" && find . -name "*.css" | sed 's|^\./||' | while read -r f; do echo "gs://$BUCKET_NAME/$f"; done | tr '\n' ' ')
if [ -n "$CSS_FILES" ]; then
  execute_with_error_check "gsutil -m setmeta -h 'Content-Type:text/css' -h 'Cache-Control:public, max-age=31536000, immutable' $CSS_FILES" "Set Content-Type and Cache-Control for CSS files"
fi

JS_FILES=$(cd "$BUILD_DIR" && find . -name "*.js" | sed 's|^\./||' | while read -r f; do echo "gs://$BUCKET_NAME/$f"; done | tr '\n' ' ')
if [ -n "$JS_FILES" ]; then
  execute_with_error_check "gsutil -m setmeta -h 'Content-Type:application/javascript' -h 'Cache-Control:public, max-age=31536000, immutable' $JS_FILES" "Set Content-Type and Cache-Control for JS files"
fi

WASM_FILES=$(cd "$BUILD_DIR" && find . -name "*.wasm" | sed 's|^\./||' | while read -r f; do echo "gs://$BUCKET_NAME/$f"; done | tr '\n' ' ')
if [ -n "$WASM_FILES" ]; then
  execute_with_error_check "gsutil -m setmeta -h 'Content-Type:application/wasm' -h 'Cache-Control:public, max-age=31536000, immutable' $WASM_FILES" "Set Content-Type and Cache-Control for WASM files"
fi

XML_FILES=$(cd "$BUILD_DIR" && find . -name "*.xml" | sed 's|^\./||' | while read -r f; do echo "gs://$BUCKET_NAME/$f"; done | tr '\n' ' ')
if [ -n "$XML_FILES" ]; then
  execute_with_error_check "gsutil -m setmeta -h 'Content-Type:application/xml' -h 'Cache-Control:public, max-age=3600' $XML_FILES" "Set Content-Type for XML files"
fi

TXT_FILES=$(cd "$BUILD_DIR" && find . -name "*.txt" | sed 's|^\./||' | while read -r f; do echo "gs://$BUCKET_NAME/$f"; done | tr '\n' ' ')
if [ -n "$TXT_FILES" ]; then
  execute_with_error_check "gsutil -m setmeta -h 'Content-Type:text/plain' -h 'Cache-Control:public, max-age=3600' $TXT_FILES" "Set Content-Type for TXT files"
fi

# --- SPA fallback + CORS ---
# Single-page app: 404s fall back to index.html so client-side routing (none yet,
# but future) and direct-URL refreshes work.
execute_with_error_check "gsutil web set -m index.html -e index.html gs://$BUCKET_NAME" "Set main page and error page for SPA"
execute_with_error_check "gsutil cors set /dev/stdin gs://$BUCKET_NAME <<< '[{\"origin\":[\"*\"],\"method\":[\"GET\"],\"maxAgeSeconds\":3600}]'" "Set CORS policy"

# --- Done ---
echo -e "\n${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}DRY RUN COMPLETED — no changes made${NC}"
else
  echo -e "${GREEN}Deployment completed!${NC}"
fi
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  URL: ${BLUE}https://$BUCKET_NAME${NC}"
echo ""
echo -e "${BLUE}Next time:${NC}"
echo "  Skip build:             $0 --skip-build"
echo "  Deploy only modified:   $0 --mode=modified"
echo "  Preview without deploy: $0 --dry-run"
