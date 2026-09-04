/**
 * 服务：分析结果开放（M2）
 *  F2-1 取数结果封装为 API（参数/返回结构/总量/抽样/分页/发布审核/在线调试/监控）
 *  F2-2 应用与凭证(AppKey/AppSecret)+令牌(30分钟)+应用-接口授权+数据/字段范围+限流+调用审计
 *  F2-3 内容混合加密：AES-256-GCM 加密业务数据 + RSA-OAEP(调用方公钥) 加密会话密钥
 */
'use strict';
const reg = require('../registry');
const cryptoLib = require('../crypto');
const engine = require('../engine');
const tasks = require('./tasks');
const approvals = require('./approvals');
const authMod = require('../auth');
const { now, json, parse } = require('../util');

const API_STATUS = ['DRAFT', 'PENDING', 'PUBLISHED', 'OFFLINE', 'REJECTED'];

// 审批副作用注册
approvals.onApprove('API_PUBLISH', (p) => { reg.run(`UPDATE sys_api SET status='PUBLISHED', updated_at=? WHERE id=?`, [now(), p.api_id]); });
approvals.onApprove('API_OFFLINE', (p) => { reg.run(`UPDATE sys_api SET status='OFFLINE', updated_at=? WHERE id=?`, [now(), p.api_id]); });
approvals.onApprove('MODEL_PUBLISH', (p) => {
  const ms = require('./models');
  const m = ms.getModel(p.model_id);
  if (m) ms.setModelStatus(p.model_id, 'PUBLISHED', { username: 'approval', role: 'APPROVER' });
});

// ---------------- 开放 API（F2-1） ----------------
function listApis() {
  const apis = reg.all(`SELECT * FROM sys_api ORDER BY id DESC`);
  for (const a of apis) {
    a.authzCount = reg.get(`SELECT COUNT(*) AS c FROM sys_authorization WHERE api_id=? AND status='ACTIVE'`, [a.id]).c;
  }
  return apis;
}
function getApi(id) {
  const a = reg.get(`SELECT * FROM sys_api WHERE id=?`, [id]);
  if (a) {
    a.authz = reg.all(`SELECT z.*, p.app_name, p.app_key FROM sys_authorization z LEFT JOIN sys_app p ON p.id=z.app_id WHERE z.api_id=?`, [id]);
    a.task = tasks.getTask(a.source_task_id) || null;
    a.param_defs = JSON.parse(a.param_defs || '[]');
    a.audit = reg.all(`SELECT * FROM sys_audit WHERE object_type='api' AND object_id=? ORDER BY id DESC LIMIT 10`, [String(id)]);
  }
  return a;
}
function getApiByPath(path) { return reg.get(`SELECT * FROM sys_api WHERE api_path=?`, [path]); }

/** 从取数任务结果“开放为API”：自动带入结果/列结构并生成参数定义 */
function openAsApi(payload, user) {
  const run = tasks.getRun(payload.run_id);
  if (!run) throw new Error('取数运行记录不存在');
  const task = tasks.getTask(run.task_id);
  if (!task || task.status !== 'SUCCESS') throw new Error('仅已成功执行的任务结果可开放为API');
  if (!run.payload || !run.payload.columns) throw new Error('该运行记录无可用结果集');
  const path = '/open/v1/' + (payload.api_path || '');
  const exists = reg.get(`SELECT id FROM sys_api WHERE api_path=?`, [path]);
  if (exists) throw new Error('服务路径已存在，请更换');
  const id = reg.insert('sys_api', {
    api_code: 'API_' + Date.now().toString(36).toUpperCase(),
    api_name: payload.api_name || (task.task_name + '-开放API'),
    api_path: path, method: 'GET', source_task_id: task.id, source_run_id: run.id,
    param_defs: json(payload.param_defs || []),
    return_struct: payload.return_struct || 'BOTH', sample_count: payload.sample_count || 50,
    page_size: payload.page_size || 100,
    limit_per_sec: payload.limit_per_sec || 10, limit_per_day: payload.limit_per_day || 10000,
    encrypt: payload.encrypt == null ? 1 : payload.encrypt, encrypt_version: 'v1',
    encrypt_alg: 'RSA-OAEP-256+AES-256-GCM',
    status: 'DRAFT', version: 1, owner: user.username, api_desc: payload.api_desc || '',
    created_at: now(), updated_at: now(),
  });
  authMod.audit(user.username, user.role, '创建开放API', 'api', id, payload.api_name);
  return getApi(id);
}

function requestPublishApi(apiId, actor) {
  const api = getApi(apiId);
  if (!api) throw new Error('API不存在');
  if (api.status === 'PUBLISHED') return { need: false, message: '已发布' };
  if (api.encrypt) {
    // 内容加密接口发布前校验至少一个应用已登记加密封装公钥，否则发布后无法使用
  }
  const r = approvals.submitOrAct('API_PUBLISH', 'api', apiId, { api_id: apiId, api_name: api.api_name }, actor.username, actor);
  if (r.need) {
    reg.run(`UPDATE sys_api SET status='PENDING', updated_at=? WHERE id=?`, [now(), apiId]);
    return { need: true, message: '已提交审批，等待审核人员审批' };
  }
  reg.run(`UPDATE sys_api SET status='PUBLISHED', updated_at=? WHERE id=?`, [now(), apiId]);
  authMod.audit(actor.username, actor.role, 'API发布', 'api', apiId, api.api_name);
  return { need: false, message: '已发布' };
}

function offlineApi(apiId, actor) {
  const api = getApi(apiId);
  const r = approvals.submitOrAct('API_OFFLINE', 'api', apiId, { api_id: apiId }, actor.username, actor);
  if (r.need) { return { need: true, message: '已提交下线审批' }; }
  reg.run(`UPDATE sys_api SET status='OFFLINE', updated_at=? WHERE id=?`, [now(), apiId]);
  authMod.audit(actor.username, actor.role, 'API下线', 'api', apiId, '');
  return { need: false, message: '已下线' };
}
function updateApi(id, patch, user) {
  const p = { ...patch };
  if ('param_defs' in p) p.param_defs = json(p.param_defs);
  reg.updateById('sys_api', id, { ...p, updated_at: now() });
  authMod.audit(user.username, user.role, 'API配置修改', 'api', id, json(patch).slice(0, 500));
  return getApi(id);
}

// ---------------- 应用与凭证（F2-2） ----------------
function listApps() {
  return reg.all(`SELECT id, app_code, app_name, app_key, status, created_by, note, created_at, updated_at FROM sys_app ORDER BY id`);
}
function getApp(id) { return reg.get(`SELECT * FROM sys_app WHERE id=?`, [id]); }
function getAppByKey(key) { return reg.get(`SELECT * FROM sys_app WHERE app_key=?`, [key]); }

function createApp(payload, user) {
  const appKey = cryptoLib.genAppKey();
  const secret = cryptoLib.genSecret();
  const id = reg.insert('sys_app', {
    app_code: 'APP_' + appKey, app_name: payload.app_name || '未命名应用', app_key: appKey,
    secret_hash: cryptoLib.hashSecret(secret), status: 'ACTIVE', created_by: user.username,
    note: payload.note || '', created_at: now(), updated_at: now(),
  });
  authMod.audit(user.username, user.role, '创建应用与凭证', 'app', id, payload.app_name);
  return { id, appKey, appSecret: secret, note: 'AppSecret仅本次展示，请妥善保存' };
}
function regenSecret(id, user) {
  const app = getApp(id);
  if (!app) throw new Error('应用不存在');
  const secret = cryptoLib.genSecret();
  reg.run(`UPDATE sys_app SET secret_hash=?, updated_at=? WHERE id=?`, [cryptoLib.hashSecret(secret), now(), id]);
  authMod.audit(user.username, user.role, '重置AppSecret', 'app', id, '');
  return { appKey: app.app_key, appSecret: secret, note: 'AppSecret仅本次展示，请妥善保存' };
}
function setAppStatus(id, status, user) {
  reg.run(`UPDATE sys_app SET status=?, updated_at=? WHERE id=?`, [status, now(), id]);
  authMod.audit(user.username, user.role, status === 'REVOKED' ? '吊销凭证' : '应用状态变更', 'app', id, status);
  return getApp(id);
}

// 调用方登记其 RSA 公钥（用于内容加密会话密钥的封装）
function registerPubKey(appId, jwk, user) {
  reg.insert('sys_app_pubkey', { app_id: appId, key_version: 'v1', public_jwk: json(jwk), created_at: now() });
  authMod.audit(user.username, user.role, '登记调用方公钥', 'app', appId, 'key version v1');
  return { ok: true };
}
function latestPubKey(appId) { return reg.get(`SELECT * FROM sys_app_pubkey WHERE app_id=? ORDER BY id DESC LIMIT 1`, [appId]); }

// ---------------- 授权关系 ----------------
function listAuthz() {
  return reg.all(`SELECT z.*, a.app_name, a.app_key, ap.api_name, ap.api_path, ap.owner
    FROM sys_authorization z LEFT JOIN sys_app a ON a.id=z.app_id LEFT JOIN sys_api ap ON ap.id=z.api_id ORDER BY z.id DESC`);
}
function createAuthz(payload, user) {
  if (!approvals.canApprove(user)) throw new Error('授权配置需由审核/安全管理员操作');
  const dup = reg.get(`SELECT id FROM sys_authorization WHERE app_id=? AND api_id=? AND status='ACTIVE'`, [payload.app_id, payload.api_id]);
  if (dup) throw new Error('该应用与API已存在有效授权');
  const id = reg.insert('sys_authorization', {
    app_id: payload.app_id, api_id: payload.api_id, data_scope: json(payload.data_scope || {}),
    field_scope: json(payload.field_scope || []), status: 'ACTIVE', approved_by: user.username,
    approved_at: now(), note: payload.note || '', created_at: now(),
  });
  authMod.audit(user.username, user.role, '开放关系授权', 'authorization', id, `app=${payload.app_id} api=${payload.api_id}`);
  return { id };
}
function revokeAuthz(id, user) {
  reg.run(`UPDATE sys_authorization SET status='REVOKED' WHERE id=?`, [id]);
  authMod.audit(user.username, user.role, '开放关系撤销', 'authorization', id, '');
  return listAuthz();
}

// ---------------- 令牌 / 限流 / 调用 ----------------
const rate = new Map(); // key appId:apiId -> {sec, sc, day, dc}
function checkRate(api, appId) {
  const k = appId + ':' + api.id;
  const t = Date.now();
  const d = new Date().toISOString().slice(0, 10);
  let r = rate.get(k);
  if (!r || r.day !== d) { r = { sec: t, sc: 0, day: d, dc: 0 }; rate.set(k, r); }
  if (t - r.sec >= 1000) { r.sec = t; r.sc = 0; }
  if (r.sc >= (api.limit_per_sec || 10)) return '超过每秒调用上限(每秒' + (api.limit_per_sec || 10) + '次)';
  if (r.dc >= (api.limit_per_day || 10000)) return '超过每日调用上限(每日' + (api.limit_per_day || 10000) + '次)';
  r.sc += 1; r.dc += 1;
  return null;
}

function applyDataScope(rows, authz) {
  const scope = JSON.parse(authz && authz.data_scope || '{}');
  const keys = Object.keys(scope || {});
  if (!keys.length) return rows;
  return rows.filter((r) => keys.every((col) => {
    const vals = scope[col] || [];
    if (!vals.length) return true;
    return vals.map(String).includes(String(r[col]));
  }));
}
function applyFieldScope(columns, authz) {
  const allow = JSON.parse(authz && authz.field_scope || '[]');
  if (!allow || !allow.length) return columns;
  return columns.filter((c) => allow.includes(c.alias));
}

/** 执行一次开放API调用（含token校验交由 handler；这里负责参数/鉴权范围/限流/加密） */
function executeCall(api, app, authz, paramsObj, { debug = false, ip = '' } = {}) {
  const run = tasks.getRun(api.source_run_id);
  if (!run || !run.payload || !run.payload.columns) {
    return { ok: false, code: 500, message: 'API所依赖的结果集不存在或已清理' };
  }
  const t0 = Date.now();
  let cols = run.payload.columns;
  const rawRows = run.payload.rows;
  // 1) 接口参数校验与过滤
  const defs = typeof api.param_defs === 'string' ? JSON.parse(api.param_defs || '[]') : (api.param_defs || []);
  const missing = defs.filter((d) => d.required && (paramsObj[d.name] == null || paramsObj[d.name] === '') && !d.defaultValue);
  if (missing.length) {
    return { ok: false, code: 400, message: `缺少必填参数：${missing.map((m) => m.name).join('、')}` };
  }
  let rows = rawRows;
  for (const d of defs) {
    let val = paramsObj[d.name];
    if ((val == null || val === '') && d.defaultValue != null) val = d.defaultValue;
    if (val == null || val === '') continue;
    const vals = Array.isArray(val) ? val : [val];
    rows = rows.filter((r) => vals.map(String).includes(String(r[d.column])));
  }
  // 2) 数据范围 + 字段范围（越权请求返回空/受限字段）
  if (authz) { rows = applyDataScope(rows, authz); cols = applyFieldScope(cols, authz); }
  // 3) 输出结构
  const total = rows.length;
  let data = null;
  const struct = api.return_struct || 'BOTH';
  if (struct === 'TOTAL') {
    data = { total };
  } else {
    let list = rows;
    if (struct === 'SAMPLE') { list = list.slice(0, api.sample_count || 50); data = { total, sampleCount: list.length, list }; }
    else {
      const pageSize = api.page_size || 100;
      const page = Math.max(1, parseInt(paramsObj.page || 1, 10) || 1);
      list = rows.slice((page - 1) * pageSize, page * pageSize);
      data = { total, page, pageSize, totalPages: Math.ceil(total / pageSize), list };
    }
  }
  // 4) 输出统一脱敏（API 视角，不允许绕过）
  cols.forEach((c) => { c.sens = !!c.sens; });
  data.list = (data.list || []).map((r) => {
    const o = { ...r };
    for (const c of cols) if (c.sens && o[c.alias] != null) o[c.alias] = engine.maskValue({ ...c, role_exempt: '[]' }, o[c.alias], 'API');
    return o;
  });
  // 5) 内容加密（F2-3）
  const latency = Date.now() - t0;
  if (api.encrypt && !debug) {
    const pk = latestPubKey(app && app.id);
    if (!pk) return { ok: false, code: 500, message: '接口已开启内容加密，但该应用尚未登记调用方RSA公钥', latency };
    const plain = { code: 0, message: 'ok', data };
    const env = cryptoLib.hybridEncrypt(JSON.parse(pk.public_jwk), plain);
    return { ok: true, code: 0, encrypted: true, alg: api.encrypt_alg, env, latency };
  }
  return { ok: true, code: 0, data, latency };
}

function logCall({ app, api, ok, statusCode, params, latency, ip, error }) {
  reg.insert('sys_call_log', {
    app_id: app ? app.id : null, app_key: app ? app.app_key : '',
    api_id: api ? api.id : null, api_path: api ? api.api_path : '',
    success: ok ? 1 : 0, status_code: statusCode, params: json(params || {}).slice(0, 500),
    latency_ms: Math.round(latency || 0), ip: ip || '', error: error ? String(error).slice(0, 300) : '', created_at: now(),
  });
}

function listCallLogs(q = {}) {
  let sql = `SELECT * FROM sys_call_log WHERE 1=1`;
  const p = [];
  if (q.apiId) { sql += ' AND api_id=?'; p.push(Number(q.apiId)); }
  if (q.appId) { sql += ' AND app_id=?'; p.push(Number(q.appId)); }
  if (q.success != null && q.success !== '') { sql += ' AND success=?'; p.push(q.success === '1' ? 1 : 0); }
  sql += ' ORDER BY id DESC LIMIT 200';
  return reg.all(sql, p);
}

function apiMonitor() {
  const rows = reg.all(`SELECT api_id, api_path, COUNT(*) AS calls, SUM(success) AS ok, AVG(latency_ms) AS avgms,
    MAX(created_at) AS last, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS fail
    FROM sys_call_log GROUP BY api_id, api_path`);
  const nowDay = now().slice(0, 10);
  const today = reg.get(`SELECT COUNT(*) AS c FROM sys_call_log WHERE created_at LIKE ?`, [nowDay + '%']);
  return { rows, total: reg.get(`SELECT COUNT(*) AS c FROM sys_call_log`).c, today: today.c };
}

module.exports = {
  API_STATUS, listApis, getApi, getApiByPath, openAsApi, requestPublishApi, offlineApi, updateApi,
  listApps, getApp, getAppByKey, createApp, regenSecret, setAppStatus, registerPubKey, latestPubKey,
  listAuthz, createAuthz, revokeAuthz,
  checkRate, executeCall, logCall, listCallLogs, apiMonitor, applyDataScope, applyFieldScope,
};
