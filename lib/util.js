'use strict';
const crypto = require('crypto');

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => now().slice(0, 10);
const pad = (n, w = 4) => String(n).padStart(w, '0');
let seq = 0;
function genCode(prefix) {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${pad(seq, 3)}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}
function newId(prefix) {
  return prefix + pad(Math.floor(Math.random() * 9000 + 1000)) + Date.now().toString(36).toUpperCase();
}
const clone = (o) => (o === undefined ? o : JSON.parse(JSON.stringify(o)));
const json = (o) => (typeof o === 'string' ? o : JSON.stringify(o));
const parse = (s, d) => { try { return s == null || s === '' ? d : JSON.parse(s); } catch (e) { return d; } };
const isNum = (v) => typeof v === 'number' && isFinite(v);
// 数字归一化：兼容 DECIMAL 以字符串返回的情况
function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}
const q = (name) => '`' + String(name).replace(/`/g, '``') + '`';
const round = (n, d = 2) => (isNum(n) ? Number(n.toFixed(d)) : n);

module.exports = { now, today, genCode, newId, clone, json, parse, toNumber, q, round, pad };
