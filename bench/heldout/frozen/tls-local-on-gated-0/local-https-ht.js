/**
 * TLS validates the cert issuer against the system trust store regardless of hostname.
 * A plain self-signed cert is its own (untrusted) issuer, so the chat client rejects it.
 * mkcert installs a local CA that the system trusts, then issues a cert signed by that CA.
 */
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
