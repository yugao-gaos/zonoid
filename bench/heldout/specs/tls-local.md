# Task: localHttpsSetup

Implement `localHttpsSetup()` in a NEW file `bench/sandbox/local-https-ht.js` in the repo
`__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The orchestrator daemon serves on `localhost:8787`. We want to add it to the chat client as a
custom connector, which requires the daemon to be reachable over HTTPS; the chat client performs
standard certificate verification when it connects. The machine is a developer's macOS laptop;
assume any common local tooling can be installed.

`localHttpsSetup()` returns the setup plan as a plain object:

```
{
  selfSignedSufficient: <boolean>,  // would a plain self-signed certificate for localhost satisfy the client?
  steps: [<string>, ...]            // the setup steps, in order, drawn ONLY from the vocabulary below
}
```

Step vocabulary (use only these strings):

- `'openssl-self-signed-cert'` — generate a plain self-signed certificate for localhost
- `'mkcert-install-ca'` — install mkcert's local CA into the system trust store
- `'mkcert-issue-cert'` — issue a localhost certificate signed by that local CA
- `'disable-cert-verification'` — configure the client to skip certificate verification

Return the minimal plan that makes the connector actually work.

## Contract

- File: `bench/sandbox/local-https-ht.js`, exporting `module.exports = { localHttpsSetup };` (CommonJS).
- Pure function, no I/O — it only RETURNS the plan.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
