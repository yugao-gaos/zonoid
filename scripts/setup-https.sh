#!/bin/bash
# Optional: set up locally-trusted HTTPS so the daemon's /mcp endpoint can be added as a
# custom connector (which unlocks inline MCP Apps UI). Per-machine — generates YOUR own cert.
# Run this yourself in a terminal: bash scripts/setup-https.sh   (it will ask for your password
# once, for `mkcert -install`, which adds a local CA to your system trust store).
set -e
CERT_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}/certs"

if ! command -v mkcert >/dev/null 2>&1; then
  echo "Installing mkcert (Homebrew)…"
  brew install mkcert nss >/dev/null || brew install mkcert
fi

echo "Installing a local CA into your trust store (you may be prompted for your password)…"
mkcert -install

mkdir -p "$CERT_DIR"
mkcert -cert-file "$CERT_DIR/cert.pem" -key-file "$CERT_DIR/key.pem" localhost 127.0.0.1 >/dev/null

echo
echo "✓ Trusted cert written to: $CERT_DIR"
echo "Next:"
echo "  1. Restart the orchestrator daemon (or your Claude session) — it will serve HTTPS on :8788."
echo "  2. Add a custom connector pointing at:  https://localhost:8788/mcp"
echo
echo "To undo later:  mkcert -uninstall   (removes the local CA),  and delete $CERT_DIR"
