/**
 * 认证 / 加密基础能力：
 *  - UI 会话令牌：HMAC-SHA256 签名（仿 JWT 结构），有效期可配（默认 30 分钟）
 *  - AppSecret：加盐哈希保存（不落明文）
 *  - 混合加密(F2-3)：AES-256-GCM 加密业务数据（对称） + RSA-OAEP 加密会话密钥（非对称）
 */
'use strict';
const crypto = require('crypto');
const config = require('../config');
const { now } = require('./util');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const uiSecret = () => process.env.DEMO_UI_SECRET || 'voice-mining-ui-secret-2026';
const openSecret = () => process.env.DEMO_OPEN_SECRET || 'voice-mining-open-secret-2026';

// ---------------- 签名令牌 ----------------
function sign(claims, secret) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verify(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const expect = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(parts[2]))) return null;
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch (e) { return null; }
}

// UI 会话令牌
function uiToken(user) {
  return sign({ sub: user.username, name: user.display_name, role: user.role, typ: 'ui', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + config.sessionMinutes * 60 }, uiSecret());
}
function verifyUi(token) {
  const c = verify(token, uiSecret());
  return c && c.typ === 'ui' ? c : null;
}

// 开放 API 令牌（OAuth2 风格：AppKey/Secret 换 token，token 有效期<=30分钟）
function openToken(app) {
  return sign({ sub: app.app_key, app: app.id, typ: 'open', scope: 'api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + config.sessionMinutes * 60 }, openSecret());
}
function verifyOpen(token) {
  const c = verify(token, openSecret());
  return c && c.typ === 'open' ? c : null;
}

// ---------------- 密钥 ----------------
function hashSecret(raw) {
  return crypto.createHmac('sha256', 'voice-appsecret-pepper').update(raw).digest('hex');
}
function genSecret() {
  return 'SK' + crypto.randomBytes(18).toString('base64url').slice(0, 24);
}
function genAppKey() {
  return 'AK' + crypto.randomBytes(12).toString('base64url').slice(0, 18).toUpperCase();
}

// ---------------- 混合加密（F2-3） ----------------
function aesEncrypt(plain, keyBuf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(plain), 'utf8')), c.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function aesDecrypt(pack, keyBuf) {
  const d = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(pack.iv, 'base64'));
  d.setAuthTag(Buffer.from(pack.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(pack.ct, 'base64')), d.final()]).toString('utf8'));
}
/** 用调用方 RSA 公钥加密 AES 会话密钥 */
function rsaWrapKey(publicJwk, aesKey) {
  const key = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
  return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, aesKey).toString('base64');
}
/** 混合加密：随机会话密钥 + AES-GCM 加密数据 + RSA-OAEP 加密会话密钥 */
function hybridEncrypt(publicJwk, plain) {
  const aesKey = crypto.randomBytes(32);
  const box = aesEncrypt(plain, aesKey);
  const ek = rsaWrapKey(publicJwk, aesKey);
  return { v: 'v1', alg: 'AES-256-GCM', ek, ...box };
}
/** 调用方解密混合密文 */
function hybridDecrypt(privateJwk, env) {
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const aesKey = crypto.privateDecrypt({ key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(env.ek, 'base64'));
  return aesDecrypt(env, aesKey);
}
/** 响应签名（完整性校验）：HMAC-SHA256 over (ct+iv+tag) */
function signPayload(pack, secret) {
  return crypto.createHmac('sha256', secret).update(`${pack.ct}|${pack.iv}|${pack.tag}`).digest('hex');
}
function verifyPayload(pack, sig, secret) {
  const e = crypto.createHmac('sha256', secret).update(`${pack.ct}|${pack.iv}|${pack.tag}`).digest('hex');
  return e === sig;
}

module.exports = {
  sign, verify, uiToken, verifyUi, openToken, verifyOpen, hashSecret, genSecret, genAppKey,
  aesEncrypt, aesDecrypt, rsaWrapKey, hybridEncrypt, hybridDecrypt, signPayload, verifyPayload,
  uiSecret, openSecret,
};
