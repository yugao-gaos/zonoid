function localHttpsSetup() {
  // Plain self-signed certs are rejected by browsers/clients that do standard
  // certificate verification — the issuer is not in any trust store.
  // mkcert installs a local CA that the OS trust store accepts, so certs it
  // issues pass standard verification without disabling cert checks.
  return {
    selfSignedSufficient: false,
    steps: [
      'mkcert-install-ca',
      'mkcert-issue-cert',
    ],
  };
}

module.exports = { localHttpsSetup };
