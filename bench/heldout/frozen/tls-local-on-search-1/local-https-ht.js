// Setup plan for serving the orchestrator daemon over HTTPS so the chat client
// can add it as a custom connector.
//
// The client does standard certificate verification: TLS validates the cert's
// ISSUER against the system trust store, regardless of the hostname being
// localhost. A plain self-signed cert is its own untrusted issuer, so the
// client rejects it — self-signed is NOT sufficient.
//
// mkcert solves this: `mkcert -install` adds a trusted local CA to the system
// trust store, and a localhost cert signed by that CA then validates cleanly.
// No need to disable verification.
function localHttpsSetup() {
  return {
    selfSignedSufficient: false,
    steps: [
      'mkcert-install-ca',
      'mkcert-issue-cert',
    ],
  };
}

module.exports = { localHttpsSetup };
