# Zonoid Dashboard for VS Code and Cursor

This small extension adds two Command Palette actions:

- **Zonoid: Open Dashboard** opens the workspace-scoped task graph in an editor panel.
- **Zonoid: Open Dashboard in Browser** uses the system browser as a fallback.

The panel asks the editor to resolve the local daemon URL with `vscode.env.asExternalUri` before embedding it, so VS Code and Cursor own SSH, Dev Container, and Codespaces port forwarding. Set `zonoid.dashboardOrigin` only when the daemon already has a separately reachable HTTP(S) origin.

`zonoid init --harness cursor` installs the bundled VSIX with the Cursor CLI. To install it manually in either client:

```sh
cursor --install-extension /path/to/zonoid/packages/vscode-dashboard/zonoid-dashboard-0.1.0.vsix
code --install-extension /path/to/zonoid/packages/vscode-dashboard/zonoid-dashboard-0.1.0.vsix
```

Rebuild the checked-in VSIX deterministically with:

```sh
node packages/vscode-dashboard/package-vsix.js
```
