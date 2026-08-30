'use strict';

const documentation = require('../lib/project-documentation');

function fail(send, res, error) {
  if (error instanceof documentation.DocumentationError) {
    send(res, error.status, { ok: false, code: error.code, error: error.message });
    return true;
  }
  throw error;
}

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, readBody, targetOverlay } = ctx;

  if (p === '/documentation' && m === 'GET') {
    const T = targetOverlay({}, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    try {
      send(res, 200, { ok: true, documents: documentation.listDocuments(T.ws) });
      return true;
    } catch (error) {
      return fail(send, res, error);
    }
  }

  if (p === '/documentation/file' && m === 'GET') {
    const T = targetOverlay({}, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    try {
      send(res, 200, { ok: true, document: documentation.readDocument(T.ws, u.searchParams.get('path')) });
      return true;
    } catch (error) {
      return fail(send, res, error);
    }
  }

  if (p === '/documentation/file' && m === 'POST') {
    const body = await readBody(req);
    const T = targetOverlay(body, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    try {
      const document = documentation.writeDocument(T.ws, body.path, body.content, body.expected_hash);
      send(res, 200, { ok: true, document });
      return true;
    } catch (error) {
      return fail(send, res, error);
    }
  }

  return false;
};
