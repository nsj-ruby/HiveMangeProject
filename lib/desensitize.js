/**
 * 字段脱敏服务（F3-2）。
 * 支持的脱敏算法：掩码 / 截断 / 哈希 / 加密(可逆) / 分桶(区间化) / 置空 / 不脱敏(禁止用于敏感字段)。
 * 同一字段在 模型预览 / 组合分析输出 / 结果预览 / API 返回 中均调用本服务，保证形态一致、不可绕过。
 */
'use strict';
const crypto = require('crypto');
const reg = require('./registry');

const ALGORITHMS = [
  { key: 'MASK', name: '掩码', desc: '保留前若干位与后若干位，中间以*代替，如 138****5678' },
  { key: 'TRUNC', name: '截断', desc: '仅保留前若干位，其余丢弃' },
  { key: 'HASH', name: '哈希', desc: 'SHA-256(加盐) 不可逆，用于需精确匹配/去重场景' },
  { key: 'ENCRYPT', name: '加密', desc: 'AES-256-GCM 可逆加密，需授权+密钥方可还原' },
  { key: 'BUCKET', name: '分桶/区间化', desc: '数值字段转为区间，保留分析价值（如 20-30）' },
  { key: 'EMPTY', name: '置空', desc: '敏感内容一律置空' },
];

const DEFAULTS = {
  MASK: { keepLeft: 3, keepRight: 4, maskChar: '*', nameMode: false },
  TRUNC: { keep: 4 },
  HASH: { salt: '' },
  ENCRYPT: {},
  BUCKET: { bucketSize: 10 },
  EMPTY: {},
};

function getMaskKey() {
  const m = reg.get(`SELECT value FROM sys_meta WHERE key='mask_key'`);
  if (m) return m.value;
  const key = crypto.randomBytes(32).toString('hex');
  reg.run(`INSERT OR IGNORE INTO sys_meta(key,value) VALUES('mask_key',?)`, [key]);
  return key;
}

function aesGcm(value, key, mode) {
  // 简单二进制值支持
  const buf = Buffer.from(String(value), 'utf8');
  if (mode === 'enc') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return 'enc:' + iv.toString('base64') + ':' + ct.toString('base64') + ':' + c.getAuthTag().toString('base64');
  }
  const parts = String(value).split(':');
  if (parts[0] !== 'enc' || parts.length !== 4) return value;
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(parts[1], 'base64'));
  d.setAuthTag(Buffer.from(parts[3], 'base64'));
  return Buffer.concat([d.update(Buffer.from(parts[2], 'base64')), d.final()]).toString('utf8');
}

/** 依据字段元数据 + 目标角色执行脱敏。字段无敏感标记则原样返回。 */
function apply(field, value, role) {
  if (value == null || value === '') return value;
  if (!field || !field.is_sensitive) return value;
  // 例外授权：命中角色直接返回原文（真实场景需审批+留痕，见脱敏配置）
  let exempt = [];
  try { exempt = JSON.parse(field.role_exempt || '[]'); } catch (e) {}
  if (Array.isArray(exempt) && exempt.includes(role)) return value;

  const alg = field.mask_alg || 'MASK';
  let p = {};
  try { p = JSON.parse(field.mask_params || '{}'); } catch (e) {}
  const params = { ...DEFAULTS[alg], ...p };
  const t = String(value);

  switch (alg) {
    case 'MASK': {
      const isName = field.field_name && /name|姓名|cust_name/i.test(field.field_name);
      let keepL = params.keepLeft;
      let keepR = isName ? 0 : params.keepRight;
      if (isName && !params.keepLeft) keepL = 1;
      keepL = keepL == null ? (isName ? 1 : 3) : keepL;
      keepR = keepR == null ? (isName ? 0 : 4) : keepR;
      if (t.length <= keepL + keepR) return t[0] + '*'.repeat(Math.max(1, t.length - 1));
      return t.slice(0, keepL) + params.maskChar.repeat(Math.min(10, t.length - keepL - keepR)) + t.slice(-keepR);
    }
    case 'TRUNC': return t.slice(0, params.keep || 4);
    case 'HASH': {
      const h = crypto.createHash('sha256').update((params.salt || 'sj') + t).digest('hex');
      return h.slice(0, 4) + '…' + h.slice(-6);
    }
    case 'ENCRYPT': return aesGcm(value, getMaskKey(), 'enc');
    case 'BUCKET': {
      const n = Number(value);
      if (!Number.isFinite(n)) return value;
      const bs = params.bucketSize || 10;
      const low = Math.floor(n / bs) * bs;
      return `[${low},${low + bs})`;
    }
    case 'EMPTY': return '';
    default: return t;
  }
}

/** 还原可逆加密字段（记录审计日志由调用方负责） */
function reveal(field, value) {
  const key = getMaskKey();
  try { return aesGcm(value, key, 'dec'); } catch (e) { return value; }
}

function decryptAny(enc) {
  if (typeof enc === 'string' && enc.startsWith('enc:')) {
    try { return aesGcm(enc, getMaskKey(), 'dec'); } catch (e) { return enc; }
  }
  return enc;
}

function guessSensitiveByMeta(fieldName, fieldCn) {
  const s = (fieldName + '|' + (fieldCn || '')).toLowerCase();
  if (/phone|mobile|手机号|联系电话/.test(s)) return { sens: true, level: '高', alg: 'MASK', params: { keepLeft: 3, keepRight: 4, maskChar: '*' } };
  if (/id_card|证件号|身份证/.test(s)) return { sens: true, level: '高', alg: 'MASK', params: { keepLeft: 3, keepRight: 4, maskChar: '*' } };
  if (/cust_name|name|姓名/.test(s) && !/plan|套餐|tag/.test(s)) return { sens: true, level: '高', alg: 'MASK', params: { keepLeft: 1, keepRight: 0, maskChar: '*' } };
  if (/address|addr|地址/.test(s)) return { sens: true, level: '中', alg: 'MASK', params: { keepLeft: 4, keepRight: 0 } };
  if (/账户|帐号|account_no|acct/.test(s)) return { sens: true, level: '中', alg: 'MASK', params: { keepLeft: 3, keepRight: 4 } };
  if (/imei|imsi|iccid|终端/.test(s)) return { sens: true, level: '中', alg: 'MASK', params: { keepLeft: 4, keepRight: 4 } };
  return { sens: false, level: '' };
}

module.exports = { ALGORITHMS, apply, reveal, decryptAny, guessSensitiveByMeta, getMaskKey, aesGcm };
