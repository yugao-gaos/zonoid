'use strict';
const mcpCore = require('../lib/mcp-core');
const requestIdentity = require('../lib/request-identity');

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, readBody, MCP_CALL } = ctx;

  if (p === '/mcp') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version, x-orch-workspace, x-orch-workspace-id, x-orch-graph-repo, x-orch-target-repo', 'Access-Control-Expose-Headers': 'mcp-session-id' };
    if (m === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    if (m === 'GET') { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); res.write(': connected\n\n'); return true; }
    if (m === 'POST') {
      const msg = await readBody(req);
      const session = req.headers['mcp-session-id'] || null;
      const rpcArgs = msg && msg.params && msg.params.arguments;
      const rawIdentity = {
        workspace_id: u.searchParams.get('workspace_id') || req.headers['x-orch-workspace-id'] || (rpcArgs && rpcArgs.workspace_id),
        graph_repo: u.searchParams.get('graph_repo') || req.headers['x-orch-graph-repo']
          || u.searchParams.get('workspace') || req.headers['x-orch-workspace']
          || (rpcArgs && (rpcArgs.graph_repo || rpcArgs.workspace)),
        target_repo: u.searchParams.get('target_repo') || req.headers['x-orch-target-repo']
          || u.searchParams.get('repo_path') || (rpcArgs && (rpcArgs.target_repo || rpcArgs.repo_path)),
      };
      const identity = requestIdentity.composeClientIdentity(
        rawIdentity,
        typeof ctx.loadRegistry === 'function' ? ctx.loadRegistry() : null,
      );
      const call = identity.graph_repo
        ? mcpCore.makeCall(Number(process.env.ORCH_PORT || 8787), identity)
        : MCP_CALL;
      const resp = await mcpCore.handleRpc(msg, {
        call,
        uiHtml: mcpCore.uiHtml,
        session,
        identity,
        workspace: identity.graph_repo || undefined,
      });
      if (resp === undefined) { res.writeHead(202, cors); res.end(); return true; }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'orchestrator', 'Connection': 'close' });
      res.end(JSON.stringify(resp));
      return true;
    }
    send(res, 405, { error: 'method not allowed' }); return true;
  }

  return false;
};
