'use strict';
/**
 * claude-cli.js — shared helpers for spawning the Claude CLI (`claude -p`) from Node scripts.
 *
 * Originally extracted from scripts/onboard-learn.js so lib/headless-drain.js and other callers
 * shared one resolver + .env loader. As of the pluggable-backend work these helpers now LIVE on the
 * CLAUDE provider in lib/llm-backend.js (kind 'agentic-cli'); this module RE-EXPORTS them verbatim
 * so existing callers (lib/headless-drain.js, scripts/onboard-learn.js) keep working unchanged.
 *
 * Routing those callers through lib/llm-backend.js getActiveBackend() is a SEPARATE downstream task
 * — do NOT change their import here.
 *
 * Exports (unchanged contract):
 *   resolveClaudeBin()       — cross-platform `claude` binary path.
 *   loadEnvForClaude(root)   — load .env.local / .env into process.env (thin shim over load-env).
 *   needsShell(bin)          — true when bin is a Windows .cmd/.bat shim.
 */

const { resolveClaudeBin, loadEnvForClaude, needsShell } = require('./llm-backend');

module.exports = { resolveClaudeBin, loadEnvForClaude, needsShell };
