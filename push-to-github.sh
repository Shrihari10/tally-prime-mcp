#!/usr/bin/env bash
# One-shot: initialise git, commit everything, create the GitHub repo via `gh`,
# and push. Run this from inside the project folder.
#
# Prereqs:
#   - gh CLI installed:    brew install gh
#   - gh authenticated:    gh auth login   (pick GitHub.com, HTTPS, browser)
#
# Usage:
#   cd "/Users/shrutisaagar/Documents/Claude/Projects/Tally Prime MCP"
#   bash push-to-github.sh
#
# To change the repo name or visibility, edit REPO_NAME / VISIBILITY below.

set -euo pipefail

REPO_NAME="tally-prime-mcp"
VISIBILITY="--public"   # change to --private if you ever want private
DESCRIPTION="Tally Prime MCP server — exposes Tally Prime's XML/HTTP gateway as Model Context Protocol tools for Claude Cowork, Claude Desktop, and other MCP clients (27 tools: masters, vouchers, reports)."

echo "==> Checking prerequisites…"
command -v git >/dev/null || { echo "git is required"; exit 1; }
command -v gh  >/dev/null || { echo "gh CLI is required: brew install gh"; exit 1; }

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Running 'gh auth login'…"
  gh auth login
fi

echo "==> Cleaning any stale .git from a previous attempt…"
rm -rf .git

echo "==> Initialising fresh repo on main…"
git init -q -b main

echo "==> Staging files…"
git add -A

echo "==> Committing…"
git commit -q -m "Initial release: Tally Prime MCP server

A Model Context Protocol server that bridges Tally Prime's XML/HTTP gateway
(port 9000) to MCP clients like Claude Cowork, Claude Desktop, and ChatGPT
Desktop.

27 typed tools:
- Masters: ledgers, groups, stock items, units, godowns, cost centres
- Vouchers: sales/purchase/receipt/payment/journal/contra/stock journal/
  debit-credit notes (create, alter, cancel, get)
- Reports: trial balance, balance sheet, P&L, day book, stock summary,
  ledger account, ledger outstanding, stock item account, bills outstanding,
  chart of accounts
- Escape hatch: raw_request for custom Tally XML envelopes

Built on the documented Tally XML envelope structure:
  https://help.tallysolutions.com/understanding-tally-xml-tags/
  https://help.tallysolutions.com/xml-integration/
  https://help.tallysolutions.com/sample-xml/"

echo "==> Creating GitHub repo and pushing…"
gh repo create "$REPO_NAME" \
  $VISIBILITY \
  --source=. \
  --remote=origin \
  --push \
  --description="$DESCRIPTION"

REPO_URL=$(gh repo view --json url -q .url)
echo
echo "✓ Done!"
echo "  Repo: $REPO_URL"
echo
echo "Open in browser:"
echo "  gh repo view --web"
