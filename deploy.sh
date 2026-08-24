#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — Build the static site and deploy to AWS via CDK
#
# Usage:
#   ./deploy.sh          # Full deploy (stage + cdk deploy)
#   ./deploy.sh stage    # Only stage _site/ without deploying
#   ./deploy.sh synth    # Stage + synthesize CloudFormation (no deploy)
#   ./deploy.sh diff     # Stage + show pending infrastructure changes
#   ./deploy.sh destroy  # Tear down the entire stack
# ─────────────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SITE_DIR="$ROOT_DIR/_site"
INFRA_DIR="$ROOT_DIR/infra"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

log()  { echo -e "${BLUE}▸${NC} $*"; }
ok()   { echo -e "${GREEN}✓${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
info() { echo -e "${CYAN}ℹ${NC} $*"; }

# ─────────────────────────────────────────────────────────────────────────────
# Stage the static site into _site/
# ─────────────────────────────────────────────────────────────────────────────
stage_site() {
  log "Staging static site into _site/ ..."
  rm -rf "$SITE_DIR"
  mkdir -p "$SITE_DIR"

  # HTML entry points
  cp "$ROOT_DIR"/index.html "$ROOT_DIR"/model-viewer.html "$ROOT_DIR"/core-playground.html "$SITE_DIR/"

  # ES modules
  cp "$ROOT_DIR"/index.js "$ROOT_DIR"/event-model.js "$ROOT_DIR"/event-model-mermaid.js \
     "$ROOT_DIR"/slice-tests.js "$ROOT_DIR"/slice-tests-mermaid.js \
     "$ROOT_DIR"/codegen.js "$SITE_DIR/"

  # Static assets
  cp "$ROOT_DIR"/settings.png "$SITE_DIR/"

  # Example model overviews
  cp "$ROOT_DIR"/blueprint_dsl.md "$ROOT_DIR"/blueprint_dsl_dcb.md "$ROOT_DIR"/blueprint_dsl_fanin.md \
     "$ROOT_DIR"/loan-originations.md "$SITE_DIR/"

  # Per-slice spec directories
  cp -R "$ROOT_DIR"/blueprint_dsl_dcb-slices "$ROOT_DIR"/blueprint_dsl_fanin-slices \
        "$ROOT_DIR"/loan-originations-slices "$SITE_DIR/"

  # Generate slice manifests (GitHub Pages + S3 have no directory listing)
  node -e "
    const fs = require('fs');
    for (const d of ['blueprint_dsl_dcb-slices', 'blueprint_dsl_fanin-slices', 'loan-originations-slices']) {
      const p = '$SITE_DIR/' + d;
      const files = fs.readdirSync(p).filter(f => f.endsWith('.md')).sort();
      fs.writeFileSync(p + '/index.json', JSON.stringify(files));
    }
  "

  # Count files for feedback
  local count
  count=$(find "$SITE_DIR" -type f | wc -l | tr -d ' ')
  ok "Staged $count files into _site/"
}

# ─────────────────────────────────────────────────────────────────────────────
# Ensure CDK dependencies are installed
# ─────────────────────────────────────────────────────────────────────────────
ensure_deps() {
  if [ ! -d "$INFRA_DIR/node_modules" ]; then
    log "Installing CDK dependencies ..."
    (cd "$INFRA_DIR" && npm ci --prefer-offline)
    ok "Dependencies installed"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Pre-flight checks
# ─────────────────────────────────────────────────────────────────────────────
preflight() {
  if ! command -v aws &>/dev/null; then
    err "AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    exit 1
  fi

  if ! command -v node &>/dev/null; then
    err "Node.js not found. Install Node 18+ from https://nodejs.org"
    exit 1
  fi

  # Verify AWS credentials are configured
  if ! aws sts get-caller-identity &>/dev/null; then
    err "AWS credentials not configured. Run 'aws configure' or set AWS_PROFILE."
    exit 1
  fi

  local identity
  identity=$(aws sts get-caller-identity --query 'Arn' --output text 2>/dev/null)
  info "Deploying as: $identity"
  info "Region: ${AWS_DEFAULT_REGION:-${AWS_REGION:-us-east-1}}"
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
ACTION="${1:-deploy}"

case "$ACTION" in
  stage)
    stage_site
    ;;
  synth)
    preflight
    stage_site
    ensure_deps
    log "Synthesizing CloudFormation template ..."
    (cd "$INFRA_DIR" && npx cdk synth)
    ok "Template synthesized → infra/cdk.out/"
    ;;
  diff)
    preflight
    stage_site
    ensure_deps
    log "Comparing with deployed stack ..."
    (cd "$INFRA_DIR" && npx cdk diff)
    ;;
  deploy)
    preflight
    stage_site
    ensure_deps
    echo ""
    info "Deploying Mermaid Event Model to AWS ..."
    info "Stack: MermaidEventModelSite"
    echo ""
    (cd "$INFRA_DIR" && npx cdk deploy --require-approval never --outputs-file cdk-outputs.json)
    echo ""
    ok "Deployment complete!"
    echo ""
    # Display outputs
    if [ -f "$INFRA_DIR/cdk-outputs.json" ]; then
      SITE_URL=$(node -e "const o=require('$INFRA_DIR/cdk-outputs.json');console.log(Object.values(o)[0]?.DistributionUrl||'')")
      if [ -n "$SITE_URL" ]; then
        echo -e "  ${GREEN}🌐 Site URL:${NC} $SITE_URL"
        echo ""
      fi
    fi
    ;;
  destroy)
    preflight
    ensure_deps
    echo ""
    err "WARNING: This will destroy ALL infrastructure and site content!"
    read -rp "Type 'yes' to confirm: " confirm
    if [ "$confirm" = "yes" ]; then
      (cd "$INFRA_DIR" && npx cdk destroy --force)
      ok "Stack destroyed."
    else
      info "Aborted."
    fi
    ;;
  *)
    echo "Usage: $0 {stage|synth|diff|deploy|destroy}"
    exit 1
    ;;
esac
