'use strict';
/**
 * lib/backend-ui.js — PURE presentation logic for the dashboard backend selector
 * (pluggable-backend feature). No I/O, no DOM, no require of heavy modules: just the
 * small decisions the dashboard makes when rendering GET /config/backend, factored out
 * so they are unit-testable in Node and shared by the inline dashboard JS in
 * public/graph.html (which keeps a byte-identical copy of these tiny functions).
 *
 * The two decisions that matter:
 *   1. shouldShowAvNotice(kind) — whether the antivirus-awareness notice is shown. The
 *      notice is the EXPLICIT user requirement: agentic-cli backends spawn a hidden local
 *      CLI child (`claude -p …`) which some antivirus (e.g. Kaspersky) intercepts; the api
 *      kind spawns nothing, so the notice must NOT show for it.
 *   2. providerReadiness(provider) — maps a GET /config/backend provider entry
 *      ({ kind, isAvailable, isAuthed }) to the badge text/state the selector renders.
 *
 * Provider `kind` is one of 'agentic-cli' | 'api' (see lib/llm-backend.js PROVIDER_KINDS).
 * isAvailable is meaningful only for 'agentic-cli' (binary on disk); it is null for 'api'.
 */

/** The kind that spawns a hidden local-CLI child process (subject to AV interception). */
const AGENTIC_CLI_KIND = 'agentic-cli';

/**
 * Whether to render the antivirus-awareness notice for a provider of the given kind.
 * TRUE only for agentic-cli (spawns `claude -p …` etc.); FALSE for api (in-process, no child)
 * and for any unknown/missing kind (fail closed — never warn about a backend that spawns nothing).
 * @param {string} kind — provider kind from GET /config/backend ('agentic-cli' | 'api').
 * @returns {boolean}
 */
function shouldShowAvNotice(kind) {
  return kind === AGENTIC_CLI_KIND;
}

/**
 * The persistent AV-awareness notice copy. Centralized here so the dashboard and any future
 * surface share one wording, and a test can assert the key guidance is present.
 * @returns {string}
 */
function avNoticeText() {
  return (
    'This backend runs your local CLI by spawning hidden background processes (e.g. `claude -p`). '
    + 'Some antivirus software (e.g. Kaspersky) flags or intercepts hidden child processes as '
    + 'suspicious, which can stall background judging/learning. If you hit this: add an antivirus '
    + 'exclusion for your CLI binary and Node, or switch to the API backend (runs in-process, no '
    + 'child process — not subject to AV interception).'
  );
}

/**
 * Map a GET /config/backend provider entry to the selector's readiness badge.
 *
 * Returns { label, ok, detail } where:
 *   - ok    {boolean} — true when the provider looks ready to use (authed, and for agentic-cli
 *                       also installed). Drives the badge color (green vs. amber/red).
 *   - label {string}  — short badge text ('ready' | 'not authed' | 'not installed' | 'hosted, no install').
 *   - detail{string}  — longer hint combining install + auth state for a tooltip/subline.
 *
 * For kind 'api', isAvailable is null (nothing is installed locally) — readiness is auth-only and
 * the install dimension renders as "hosted, no install".
 *
 * @param {{ kind:string, isAvailable:(boolean|null), isAuthed:boolean }} provider
 * @returns {{ label:string, ok:boolean, detail:string }}
 */
function providerReadiness(provider) {
  const p = provider || {};
  const authed = !!p.isAuthed;
  if (p.kind === AGENTIC_CLI_KIND) {
    const installed = p.isAvailable === true;
    if (!installed) {
      return { label: 'not installed', ok: false, detail: 'CLI binary not found on this host' };
    }
    if (!authed) {
      return { label: 'not authed', ok: false, detail: 'installed, but no credentials detected' };
    }
    return { label: 'ready', ok: true, detail: 'installed and authed' };
  }
  // api kind (or anything non-agentic): in-process, nothing installed locally.
  if (!authed) {
    return { label: 'not authed', ok: false, detail: 'hosted, no install — but no API key detected' };
  }
  return { label: 'ready', ok: true, detail: 'hosted, no install — API key detected' };
}

module.exports = {
  AGENTIC_CLI_KIND,
  shouldShowAvNotice,
  avNoticeText,
  providerReadiness,
};
