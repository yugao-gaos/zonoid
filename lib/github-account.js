'use strict';

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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

function resolveGhExecutable(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const existsSync = options.existsSync || fs.existsSync;
  if (env.ZONOID_GH_PATH) return env.ZONOID_GH_PATH;

  const candidates = platform === 'win32'
    ? [env.ProgramFiles && path.win32.join(env.ProgramFiles, 'GitHub CLI', 'gh.exe')]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return platform === 'win32' ? 'gh.exe' : 'gh';
}

function defaultRunGh(args, executable = resolveGhExecutable()) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(error);
      resolve(String(stdout || ''));
    });
  });
}

function defaultRunGhSync(args, executable = resolveGhExecutable()) {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function makeScope(remoteInfo, token, executable, options = {}) {
  const platform = options.platform || process.platform;
  const env = { ...(options.env || process.env), GH_TOKEN: token, GITHUB_TOKEN: token };
  const pathApi = platform === 'win32' ? path.win32 : path;
  if (pathApi.isAbsolute(executable)) {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = [pathApi.dirname(executable), env[pathKey]].filter(Boolean).join(pathApi.delimiter);
  }
  return {
    github: true,
    host: remoteInfo.host,
    owner: remoteInfo.owner,
    env,
    gitArgs: credentialArgs(),
  };
}

async function scopeForRemote(remote, options = {}) {
  const remoteInfo = parseRemote(remote);
  if (!remoteInfo) return null;
  const executable = options.ghExecutable || resolveGhExecutable(options);
  const runGh = typeof options.runGh === 'function'
    ? options.runGh
    : (args) => defaultRunGh(args, executable);
  let token;
  try {
    token = String(await runGh(['auth', 'token', '--hostname', remoteInfo.host, '--user', remoteInfo.owner]) || '').trim();
  } catch {
    throw sanitizedAuthError(remoteInfo.owner);
  }
  if (!token) throw sanitizedAuthError(remoteInfo.owner);
  return makeScope(remoteInfo, token, executable, options);
}

function scopeForRemoteSync(remote, options = {}) {
  const remoteInfo = parseRemote(remote);
  if (!remoteInfo) return null;
  const executable = options.ghExecutable || resolveGhExecutable(options);
  const runGhSync = typeof options.runGhSync === 'function'
    ? options.runGhSync
    : (args) => defaultRunGhSync(args, executable);
  let token;
  try {
    token = String(runGhSync(['auth', 'token', '--hostname', remoteInfo.host, '--user', remoteInfo.owner]) || '').trim();
  } catch {
    throw sanitizedAuthError(remoteInfo.owner);
  }
  if (!token) throw sanitizedAuthError(remoteInfo.owner);
  return makeScope(remoteInfo, token, executable, options);
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
  resolveGhExecutable,
  scopeForRemote,
  scopeForRemoteSync,
  withOwnerCredential,
  withOwnerCredentialSync,
};
