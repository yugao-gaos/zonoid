'use strict';
const mcpCore = require('../lib/mcp-core');

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, readBody, MCP_CALL } = ctx;

  if (p === '/mcp') {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version, x-orch-workspace', 'Access-Control-Expose-Headers': 'mcp-session-id' };
    if (m === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    if (m === 'GET') { res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); res.write(': connected\n\n'); return true; }
    if (m === 'POST') {
      const msg = await readBody(req);
      const session = req.headers['mcp-session-id'] || null;
      const rpcArgs = msg && msg.params && msg.params.arguments;
      const rpcWorkspace = rpcArgs && typeof rpcArgs.workspace === 'string' ? rpcArgs.workspace : null;
      const reqWorkspace = u.searchParams.get('workspace') || req.headers['x-orch-workspace'] || rpcWorkspace || null;
      const call = reqWorkspace ? mcpCore.makeCall(Number(process.env.ORCH_PORT || 8787), reqWorkspace) : MCP_CALL;
      const resp = await mcpCore.handleRpc(msg, { call, uiHtml: mcpCore.uiHtml, session, workspace: reqWorkspace || undefined });
      if (resp === undefined) { res.writeHead(202, cors); res.end(); return true; }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'orchestrator', 'Connection': 'close' });
      res.end(JSON.stringify(resp));
      return true;
    }
    send(res, 405, { error: 'method not allowed' }); return true;
  }

  return false;
};
