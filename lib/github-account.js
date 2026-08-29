'use strict';

const { execFile, execFileSync } = require('child_process');

const GITHUB_HOST = 'github.com';

function parseRemote(remote) {
  const value = String(remote || '').trim();
  let match = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) match = value.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) match = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return { host: GITHUB_HOST, owner: match[1], repo: match[2] };
}

function credentialArgs() {
  return [
    '-c', 'credential.https://github.com.helper=',
    '-c', 'credential.https://github.com.helper=!gh auth git-credential',
    '-c', 'url.https://github.com/.insteadOf=git@github.com:',
    '-c', 'url.https://github.com/.insteadOf=ssh://git@github.com/',
  ];
}

function sanitizedAuthError(owner) {
  const error = new Error(`GitHub account "${owner}" is not authenticated; run gh auth login for that account`);
  error.code = 'github_owner_not_authenticated';
  return error;
}

function defaultRunGh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(error);
      resolve(String(stdout || ''));
    });
  });
}

function defaultRunGhSync(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeScope(remoteInfo, token) {
  return {
    github: true,
    host: remoteInfo.host,
    owner: remoteInfo.owner,
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
    gitArgs: credentialArgs(),
  };
}

async function scopeForRemote(remote, options = {}) {
  const remoteInfo = parseRemote(remote);
  if (!remoteInfo) return null;
  const runGh = typeof options.runGh === 'function' ? options.runGh : defaultRunGh;
  let token;
  try {
    token = String(await runGh(['auth', 'token', '--hostname', remoteInfo.host, '--user', remoteInfo.owner]) || '').trim();
  } catch {
    throw sanitizedAuthError(remoteInfo.owner);
  }
  if (!token) throw sanitizedAuthError(remoteInfo.owner);
  return makeScope(remoteInfo, token);
}

function scopeForRemoteSync(remote, options = {}) {
  const remoteInfo = parseRemote(remote);
  if (!remoteInfo) return null;
  const runGhSync = typeof options.runGhSync === 'function' ? options.runGhSync : defaultRunGhSync;
  let token;
  try {
    token = String(runGhSync(['auth', 'token', '--hostname', remoteInfo.host, '--user', remoteInfo.owner]) || '').trim();
  } catch {
    throw sanitizedAuthError(remoteInfo.owner);
  }
  if (!token) throw sanitizedAuthError(remoteInfo.owner);
  return makeScope(remoteInfo, token);
}

async function withOwnerCredential(remote, operation, options = {}) {
  const scope = await scopeForRemote(remote, options);
  return operation(scope);
}

function withOwnerCredentialSync(remote, operation, options = {}) {
  const scope = scopeForRemoteSync(remote, options);
  return operation(scope);
}

function gitArgs(scope, args) {
  return scope ? [...scope.gitArgs, ...args] : args;
}

function gitOptions(scope, options = {}) {
  if (!scope) return options;
  return { ...options, env: scope.env };
}

module.exports = {
  gitArgs,
  gitOptions,
  parseRemote,
  scopeForRemote,
  scopeForRemoteSync,
  withOwnerCredential,
  withOwnerCredentialSync,
};
