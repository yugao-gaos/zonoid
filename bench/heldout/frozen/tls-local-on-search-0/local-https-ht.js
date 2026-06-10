// Setup plan for serving the orchestrator daemon over HTTPS so the chat client
// can add it as a custom connector.
//
// The client performs standard certificate verification: TLS validates the
// cert's ISSUER against the system trust store, regardless of `localhost`.
// A plain self-signed cert is its own untrusted issuer, so it is rejected.
// mkcert fixes this by installing a local CA into the trust store
// (`mkcert -install`) and issuing a localhost cert signed by that trusted CA.
// Disabling verification is not an option — the chat client verifies and we
// cannot configure it to skip, and the goal is for the connector to actually work.

function localHttpsSetup() {
  return {
    selfSignedSufficient: false,
    steps: ['mkcert-install-ca', 'mkcert-issue-cert'],
  };
}

module.exports = { localHttpsSetup };
