#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const PACKAGE_FILES = ['manifest.json', 'server/index.js'];
const DOS_EPOCH_DATE = 33; // 1980-01-01

// Every packaged file is text. A Windows checkout (core.autocrlf=true) materialises the sources
// with CRLF, so reading raw bytes would produce a different archive than the same commit built on
// macOS/Linux — the checked-in .mcpb would never match. Canonicalise to LF at read time so the
// archive is a function of the committed content, not of the checkout's EOL policy.
function normalizeText(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function readPackageFile(root, name) {
  return normalizeText(fs.readFileSync(path.join(root, name)));
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'));
    const body = Buffer.from(entry.body);
    const checksum = crc32(body);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(DOS_EPOCH_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    locals.push(localHeader, name, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(DOS_EPOCH_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(body.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + body.length;
  }

  const centralSize = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...central, end]);
}

function validateSource(root = __dirname) {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.manifest_version !== '0.3') throw new Error('manifest_version must be 0.3');
  if (manifest.server?.type !== 'node') throw new Error('server.type must be node');
  if (manifest.server?.entry_point !== 'server/index.js') throw new Error('server.entry_point must be server/index.js');
  if (!manifest.server?.mcp_config?.args?.includes('${__dirname}/server/index.js')) {
    throw new Error('server.mcp_config must launch ${__dirname}/server/index.js');
  }
  if (manifest.server?.mcp_config?.env?.ZONOID_INSTALL_DIR !== '${user_config.zonoid_install_dir}') {
    throw new Error('server must receive the configured Zonoid install directory');
  }
  for (const file of PACKAGE_FILES) {
    if (!fs.existsSync(path.join(root, file))) throw new Error(`missing package file: ${file}`);
  }
  return manifest;
}

function build({ root = __dirname, output = path.join(root, 'zonoid-dashboard.mcpb') } = {}) {
  validateSource(root);
  const entries = PACKAGE_FILES.map((name) => ({ name, body: readPackageFile(root, name) }));
  const archive = createZip(entries);
  fs.writeFileSync(output, archive);
  return { output, bytes: archive.length, files: PACKAGE_FILES.slice() };
}

if (require.main === module) {
  const result = build();
  console.log(`Built ${result.output} (${result.bytes} bytes)`);
}

module.exports = { PACKAGE_FILES, crc32, createZip, normalizeText, readPackageFile, validateSource, build };
