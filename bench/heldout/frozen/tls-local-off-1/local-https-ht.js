// Setup plan for serving the orchestrator daemon (localhost:8787) over HTTPS
// so the chat client can add it as a custom connector.
//
// The client performs standard certificate verification on connect. A plain
// self-signed cert for localhost is not chained to any trusted CA, so that
// verification fails — it is NOT sufficient. We also cannot change the client's
// verification behavior, so skipping verification is not a viable path.
//
// The minimal plan that actually works: install mkcert's local CA into the
// system trust store, then issue a localhost cert signed by that now-trusted CA.
function localHttpsSetup() {
  return {
    selfSignedSufficient: false,
    steps: ['mkcert-install-ca', 'mkcert-issue-cert'],
  };
}

module.exports = { localHttpsSetup };
