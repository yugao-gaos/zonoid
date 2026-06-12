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
