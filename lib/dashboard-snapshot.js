'use strict';

const zlib = require('zlib');
const frontier = require('./frontier');
const overlayStore = require('./overlay');
const { buildKanbanProjection } = require('./kanban');

const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 1280;
const DEFAULT_LIMIT = 4;
const OPAQUE_TASK_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/\d+)?$/i;
const UUID_FRAGMENT = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const COLORS = Object.freeze({
  background: [10, 15, 26, 255],
  panel: [22, 30, 46, 255],
  panelAlt: [28, 38, 57, 255],
  text: [237, 242, 250, 255],
  muted: [153, 166, 187, 255],
  plan: [132, 145, 166, 255],
  ready: [70, 174, 255, 255],
  wip: [84, 218, 180, 255],
  review: [175, 129, 255, 255],
  needs: [255, 183, 77, 255],
  danger: [255, 103, 123, 255],
  done: [111, 207, 151, 255],
});

// Fixed 5x7 uppercase font keeps rendering dependency-free and byte-stable. Non-ASCII characters
// become '?'; the accessible text retains their sanitized Unicode form.
const FONT = Object.freeze({
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
  ',': ['00000', '00000', '00000', '00000', '00110', '00100', '01000'],
  ':': ['00000', '00110', '00110', '00000', '00110', '00110', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '[': ['01110', '01000', '01000', '01000', '01000', '01000', '01110'],
  ']': ['01110', '00010', '00010', '00010', '00010', '00010', '01110'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
});

function lexical(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  const parsed = Date.parse(value || '');
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

const CREDENTIAL_ASSIGNMENT = /["']?\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|aws[_ -]?secret[_ -]?access[_ -]?key|password|secret|token)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;
const WRAPPERS = Object.freeze({ '"': '"', "'": "'", '[': ']', '<': '>' });

function isAbsoluteLocalPath(value) {
  const text = String(value || '').trim();
  return /^file:\/\//i.test(text)
    || /^[A-Za-z]:[\\/]/.test(text)
    || /^(?:\\\\|\/\/)[^\\/]/.test(text)
    || /^\/(?!\/)/.test(text);
}

function wrappedEnd(text, start, closer) {
  for (let index = start + 1; index < text.length; index++) {
    if ((closer === '"' || closer === "'") && text[index] === '\\') {
      index++;
      continue;
    }
    if (text[index] === closer) return index;
  }
  return -1;
}

function redactWrappedPaths(value) {
  const text = String(value || '');
  let output = '';
  let cursor = 0;
  while (cursor < text.length) {
    const closer = WRAPPERS[text[cursor]];
    if (!closer) {
      output += text[cursor++];
      continue;
    }
    const end = wrappedEnd(text, cursor, closer);
    if (end < 0) {
      output += text[cursor++];
      continue;
    }
    const wrapped = text.slice(cursor + 1, end);
    output += isAbsoluteLocalPath(wrapped) ? '[local path]' : text.slice(cursor, end + 1);
    cursor = end + 1;
  }
  return output;
}

function sanitizeDisplayText(value, fallback = '', maxLength = 180) {
  let text = redactWrappedPaths(String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(CREDENTIAL_ASSIGNMENT, '[secret]'))
    .replace(/file:\/\/[^\s)\]}>]+/gi, '[local path]')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s)\]}>]*)?/gi, '[local service]')
    .replace(/(^|[\s("'`=])\\\\[^\\\s)\]}>;,]+\\[^\s)\]}>;,]+/g, '$1[local path]')
    .replace(/(^|[\s("'`=])\/\/[^/\s]+\/[^\s)\]}>;,]+/g, '$1[local path]')
    .replace(/\b[A-Za-z]:[\\/][^\s)\]}>;,]+/g, '[local path]')
    .replace(/(^|[\s("'`=]|:(?!\/\/))\/(?!\/)[^\s)\]}>;,]+/g, '$1[local path]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [secret]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[secret]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, '[secret]')
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[secret]')
    .replace(UUID_FRAGMENT, '[private id]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) text = fallback;
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  return text;
}

function taskTitle(task) {
  const key = String(task && task.id || '');
  const label = String(task && task.label || '');
  const raw = OPAQUE_TASK_KEY.test(key) && (!label || label === key)
    ? 'Untitled legacy task'
    : (label || key || 'Untitled task');
  return sanitizeDisplayText(raw, 'Untitled task', 140);
}

function operationalTasks(tasks) {
  return (tasks || []).filter((task) => task && task.id
    && !overlayStore.isNonTaskNode(task)
    && !frontier.isInternalTask(task));
}

function guidanceTaskKey(item) {
  const action = item && item.action || {};
  return action.task_key || action.taskKey || item && item.origin_task || null;
}

function taskActivity(task) {
  return timestamp(task && (
    task.completed_at || task.merged_at || task.reviewed_at || task.lastChanged
    || task.updated_at || task.created_at || task.firstSeen
  ));
}

function sortedTasks(tasks) {
  return [...tasks].sort((a, b) => taskActivity(b) - taskActivity(a) || lexical(taskTitle(a), taskTitle(b)));
}

function clipped(items, limit) {
  return { items: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

function sectionLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, 10) : DEFAULT_LIMIT;
}

function displayCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function buildDashboardSnapshot({
  tasks = [],
  frontierTaskIds,
  pinnedTaskIds = [],
  guidance = [],
  now,
  limit,
} = {}) {
  const generatedAt = isoTimestamp(now);
  const maxItems = sectionLimit(limit);
  const visibleTasks = operationalTasks(tasks);
  const kanban = buildKanbanProjection({
    tasks: visibleTasks,
    frontierTaskIds,
    pinnedTaskIds,
    guidance,
  });
  const byId = new Map(visibleTasks.map((task) => [task.id, task]));
  const scopedTaskIds = new Set(kanban.cards.map((card) => card.task_key));
  const scopedTasks = kanban.cards.map((card) => byId.get(card.task_key)).filter(Boolean);
  const wip = scopedTasks.filter((task) => String(task.status || '').toLowerCase() === 'in_progress');
  const userDecisions = (guidance || [])
    .filter((item) => item && !item.resolved && overlayStore.guidanceAudience(item) === 'user'
      && scopedTaskIds.has(guidanceTaskKey(item)))
    .map((item) => ({
      title: sanitizeDisplayText(item.question, 'Decision requested', 160),
      at: timestamp(item.created_at || item.createdAt || item.requested_at),
    }))
    .sort((a, b) => b.at - a.at || lexical(a.title, b.title));
  const attention = scopedTasks.filter((task) => {
    const status = String(task.status || '').toLowerCase();
    const merge = String(task.merge_state || '').toLowerCase();
    const review = String(task.review_state || '').toLowerCase();
    const blockedDeps = status === 'not_ready' && Array.isArray(task.deps) && task.deps.length > 0;
    return status === 'failed' || status === 'blocked' || blockedDeps
      || merge === 'conflict' || merge === 'failed' || review === 'rejected';
  });
  const completions = scopedTasks.filter((task) => {
    const status = String(task.status || '').toLowerCase();
    return status === 'done' || String(task.merge_state || '').toLowerCase() === 'merged'
      || String(task.review_state || '').toLowerCase() === 'landed';
  });

  const wipSection = clipped(sortedTasks(wip).map((task) => taskTitle(task)), maxItems);
  const decisionSection = clipped(userDecisions.map((item) => item.title), maxItems);
  const attentionSection = clipped(sortedTasks(attention).map((task) => ({
    title: taskTitle(task),
    state: String(task.status || '').toLowerCase() === 'failed'
      || ['conflict', 'failed'].includes(String(task.merge_state || '').toLowerCase())
      || String(task.review_state || '').toLowerCase() === 'rejected'
      ? 'Failed'
      : 'Blocked',
  })), maxItems);
  const completionSection = clipped(sortedTasks(completions).map((task) => taskTitle(task)), maxItems);
  const lanes = kanban.summary.lanes;

  return {
    version: 1,
    scope: 'workspace',
    generated_at: generatedAt,
    counts: {
      plan: lanes.queue || 0,
      ready: lanes.ready || 0,
      wip: lanes.wip || 0,
      review: lanes.review || 0,
      needs_you: userDecisions.length,
    },
    current_wip: wipSection.items,
    user_decisions: decisionSection.items,
    blocked_failed: attentionSection.items,
    recent_completions: completionSection.items,
    omitted: {
      current_wip: wipSection.omitted,
      user_decisions: decisionSection.omitted,
      blocked_failed: attentionSection.omitted,
      recent_completions: completionSection.omitted,
    },
  };
}

function sectionText(label, items, omitted, format = (item) => String(item)) {
  const lines = [label];
  if (!items.length) lines.push('- None');
  else for (const item of items) lines.push(`- ${sanitizeDisplayText(format(item), 'Untitled item')}`);
  if (displayCount(omitted)) lines.push(`- +${displayCount(omitted)} more`);
  return lines.join('\n');
}

function dashboardSnapshotText(snapshot) {
  const counts = Object.fromEntries(Object.entries(snapshot.counts || {})
    .map(([key, value]) => [key, displayCount(value)]));
  return [
    `Zonoid workspace status — ${sanitizeDisplayText(snapshot.generated_at)}`,
    `PLAN ${counts.plan} | READY ${counts.ready} | WIP ${counts.wip} | REVIEW ${counts.review} | NEEDS YOU ${counts.needs_you}`,
    '',
    sectionText('CURRENT WIP', snapshot.current_wip, snapshot.omitted.current_wip),
    '',
    sectionText('NEEDS YOU', snapshot.user_decisions, snapshot.omitted.user_decisions),
    '',
    sectionText('BLOCKED / FAILED', snapshot.blocked_failed, snapshot.omitted.blocked_failed,
      (item) => `${item.state}: ${item.title}`),
    '',
    sectionText('RECENTLY COMPLETED', snapshot.recent_completions, snapshot.omitted.recent_completions),
  ].join('\n');
}

function raster(width, height, color) {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = color[0];
    data[offset + 1] = color[1];
    data[offset + 2] = color[2];
    data[offset + 3] = color[3];
  }
  return { width, height, data };
}

function fillRect(image, x, y, width, height, color) {
  const left = Math.max(0, Math.floor(x));
  const top = Math.max(0, Math.floor(y));
  const right = Math.min(image.width, Math.ceil(x + width));
  const bottom = Math.min(image.height, Math.ceil(y + height));
  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) {
      const offset = (row * image.width + column) * 4;
      image.data[offset] = color[0];
      image.data[offset + 1] = color[1];
      image.data[offset + 2] = color[2];
      image.data[offset + 3] = color[3];
    }
  }
}

function ascii(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/[^ A-Z0-9?!.,:\-\/+()[\]]/g, '?');
}

function textWidth(value, scale) {
  return Math.max(0, ascii(value).length * 6 * scale - scale);
}

function drawText(image, value, x, y, scale, color) {
  let cursor = x;
  for (const character of ascii(value)) {
    const glyph = FONT[character] || FONT['?'];
    for (let row = 0; row < glyph.length; row++) {
      for (let column = 0; column < glyph[row].length; column++) {
        if (glyph[row][column] === '1') {
          fillRect(image, cursor + column * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += 6 * scale;
  }
  return cursor;
}

function fitted(value, maxCharacters) {
  const text = ascii(value);
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`;
}

function drawCountCard(image, x, y, width, label, count, color) {
  fillRect(image, x, y, width, 112, COLORS.panel);
  fillRect(image, x, y, 6, 112, color);
  const countText = String(displayCount(count));
  drawText(image, countText, x + (width - textWidth(countText, 4)) / 2, y + 20, 4, COLORS.text);
  drawText(image, label, x + (width - textWidth(label, 2)) / 2, y + 76, 2, color);
}

function drawSection(image, y, title, items, omitted, color, itemText) {
  const x = 36;
  const width = image.width - 72;
  fillRect(image, x, y, width, 202, COLORS.panelAlt);
  fillRect(image, x, y, 7, 202, color);
  drawText(image, title, x + 22, y + 18, 3, color);
  fillRect(image, x + 22, y + 48, width - 44, 2, COLORS.panel);
  const visible = items.slice(0, 4);
  if (!visible.length) {
    drawText(image, 'NONE', x + 24, y + 72, 2, COLORS.muted);
  } else {
    visible.forEach((item, index) => {
      const value = fitted(sanitizeDisplayText(itemText(item), 'Untitled item'), Math.floor((width - 60) / 12));
      drawText(image, '-', x + 24, y + 66 + index * 28, 2, color);
      drawText(image, value, x + 46, y + 66 + index * 28, 2, COLORS.text);
    });
  }
  if (displayCount(omitted)) drawText(image, `+${displayCount(omitted)} MORE`, x + 24, y + 174, 2, COLORS.muted);
}

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function encodePng(image) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const scanlines = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let row = 0; row < image.height; row++) {
    const target = row * (image.width * 4 + 1);
    scanlines[target] = 0;
    image.data.copy(scanlines, target + 1, row * image.width * 4, (row + 1) * image.width * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function renderDashboardSnapshotPng(snapshot, options = {}) {
  const width = Number.isInteger(options.width) && options.width >= 640 ? options.width : DEFAULT_WIDTH;
  const height = Number.isInteger(options.height) && options.height >= 1280 ? options.height : DEFAULT_HEIGHT;
  const image = raster(width, height, COLORS.background);
  drawText(image, 'ZONOID STATUS', 36, 36, 5, COLORS.text);
  drawText(image, sanitizeDisplayText(snapshot.generated_at), 38, 88, 2, COLORS.muted);
  fillRect(image, 36, 122, width - 72, 2, COLORS.panelAlt);

  const cards = [
    ['PLAN', snapshot.counts.plan, COLORS.plan],
    ['READY', snapshot.counts.ready, COLORS.ready],
    ['WIP', snapshot.counts.wip, COLORS.wip],
    ['REVIEW', snapshot.counts.review, COLORS.review],
    ['NEEDS YOU', snapshot.counts.needs_you, COLORS.needs],
  ];
  const gap = 8;
  const cardWidth = Math.floor((width - 72 - gap * 4) / 5);
  cards.forEach(([label, count, color], index) => {
    drawCountCard(image, 36 + index * (cardWidth + gap), 148, cardWidth, label, count, color);
  });

  drawSection(image, 288, 'CURRENT WIP', snapshot.current_wip, snapshot.omitted.current_wip,
    COLORS.wip, (item) => item);
  drawSection(image, 510, 'NEEDS YOU', snapshot.user_decisions, snapshot.omitted.user_decisions,
    COLORS.needs, (item) => item);
  drawSection(image, 732, 'BLOCKED / FAILED', snapshot.blocked_failed, snapshot.omitted.blocked_failed,
    COLORS.danger, (item) => `${item.state}: ${item.title}`);
  drawSection(image, 954, 'RECENTLY COMPLETED', snapshot.recent_completions, snapshot.omitted.recent_completions,
    COLORS.done, (item) => item);
  drawText(image, 'PORTABLE WORKSPACE SNAPSHOT', 36, Math.min(height - 48, 1190), 2, COLORS.muted);
  return encodePng(image);
}

function createDashboardSnapshot(input = {}, options = {}) {
  const snapshot = buildDashboardSnapshot({ ...input, now: options.now ?? input.now, limit: options.limit ?? input.limit });
  const text = dashboardSnapshotText(snapshot);
  const png = renderDashboardSnapshotPng(snapshot, options);
  return {
    version: 1,
    mime_type: 'image/png',
    width: Number.isInteger(options.width) && options.width >= 640 ? options.width : DEFAULT_WIDTH,
    height: Number.isInteger(options.height) && options.height >= 1280 ? options.height : DEFAULT_HEIGHT,
    generated_at: snapshot.generated_at,
    snapshot,
    text,
    png,
    png_base64: png.toString('base64'),
  };
}

module.exports = {
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  OPAQUE_TASK_KEY,
  sanitizeDisplayText,
  taskTitle,
  buildDashboardSnapshot,
  dashboardSnapshotText,
  renderDashboardSnapshotPng,
  createDashboardSnapshot,
  _internal: { crc32, encodePng, FONT },
};
