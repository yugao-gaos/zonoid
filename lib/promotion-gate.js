'use strict';
const fs = require('fs');
const path = require('path');
const { agreementRate } = require('./shadow-journal');

const PROMOTION_THRESHOLD = Number(process.env.PROMOTION_THRESHOLD) || 0.85;
const PROMOTION_MIN_ROWS = Number(process.env.PROMOTION_MIN_ROWS) || 50;

function promotionFile(ws) {
  return path.join(ws, '.graph', 'promotion-state.json');
}

function getPromotionState(ws) {
  try {
    const raw = fs.readFileSync(promotionFile(ws), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { promoted: false };
  }
}

function checkAndPromote(ws) {
  const current = getPromotionState(ws);
  if (current.promoted) return { promoted: true };

  const ar = agreementRate(ws);
  if (!ar || ar.total < PROMOTION_MIN_ROWS || ar.rate < PROMOTION_THRESHOLD) {
    return { promoted: false };
  }

  const state = { promoted: true, promotedAt: Date.now(), rate: ar.rate, total: ar.total };
  try {
    fs.writeFileSync(promotionFile(ws), JSON.stringify(state), 'utf8');
  } catch { /* best-effort */ }
  return { promoted: true, justPromoted: true };
}

module.exports = { getPromotionState, checkAndPromote, PROMOTION_THRESHOLD, PROMOTION_MIN_ROWS };
