// localHttpsSetup — plan for serving the orchestrator daemon over HTTPS so the
// chat client can add it as a custom connector.
//
// The client performs STANDARD certificate verification: the cert must chain to
// a CA in the system trust store. A plain self-signed cert for localhost is not
// signed by any trusted CA, so it fails verification — `selfSignedSufficient` is
// false. mkcert handles this properly: install its local CA into the trust store,
// then issue a localhost cert signed by that CA. No need to disable verification.

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
