'use strict';

function workspacePayload(workspace) {
  const path = typeof workspace === 'string' ? workspace : '';
  return path ? { path } : null;
}

async function postWorkspace(workspace, post) {
  const body = workspacePayload(workspace);
  if (!body || typeof post !== 'function') return null;
  try {
    return await post('/workspace', body);
  } catch {
    return null;
  }
}

function textFromPart(part) {
  if (!part || part.type !== 'text') return '';
  if (typeof part.text === 'string') return part.text;
  if (part.text && typeof part.text.value === 'string') return part.text.value;
  return '';
}

function promptFromParts(parts) {
  if (!Array.isArray(parts)) return '';
  return parts.map(textFromPart).filter(Boolean).join('\n');
}

function classifyPayload({ prompt, sessionID, workspace }) {
  const body = { prompt };
  if (sessionID) body.session_id = String(sessionID);
  if (workspace) body.workspace = workspace;
  return body;
}

function contextFromResponse(response) {
  if (!response || typeof response !== 'object') return '';
  const context = response.additional_context ?? response.additionalContext ?? response.context;
  if (typeof context !== 'string' || !context.trim()) return '';
  return context;
}

function appendContextPart(parts, context) {
  if (!Array.isArray(parts) || !context) return false;
  parts.push({ type: 'text', text: context });
  return true;
}

async function injectClassifiedContext(input, output, opts = {}) {
  const parts = output && Array.isArray(output.parts) ? output.parts : [];
  const prompt = promptFromParts(parts).trim();
  if (!prompt || typeof opts.post !== 'function') return false;

  try {
    const response = await opts.post('/classify', classifyPayload({
      prompt,
      sessionID: input && input.sessionID,
      workspace: opts.workspace,
    }));
    return appendContextPart(parts, contextFromResponse(response));
  } catch {
    return false;
  }
}

module.exports = {
  appendContextPart,
  classifyPayload,
  contextFromResponse,
  injectClassifiedContext,
  postWorkspace,
  promptFromParts,
  textFromPart,
  workspacePayload,
};
