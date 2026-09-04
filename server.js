/**
 * Demo 服务入口：零依赖 HTTP 服务
 *  - 前端静态资源（web/）
 *  - 内部 REST 接口（/api/*，UI 会话令牌认证）
 *  - 对外开放接口（/open/*，AppKey/Secret 换 Token + 限流 + 混合加密）
 * 启动时：初始化业务数据源(建 11 张表 + 100行/表) → 打开注册表 → 装载内置函数 → 启动周期任务调度。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const reg = require('./lib/registry');
const authMod = require('./lib/auth');
const cryptoLib = require('./lib/crypto');
const { parse, json, now } = require('./lib/util');
const { initBusiness, getBiz, getStatus } = require('./lib/biz');

const modelsSvc = require('./lib/services/models');
const funcsSvc = require('./lib/services/funcs');
const tasksSvc = require('./lib/services/tasks');
const openSvc = require('./lib/services/open');
const approvalsSvc = require('./lib/services/approvals');
const provisionSvc = require('./lib/services/provision');

// ---------- 基础工具 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' });
  res.end(body);
}
function bodyParser(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 12 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; } data += c; });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('请求体不是合法JSON')); } });
    req.on('error', reject);
  });
}
function uiUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return authMod.resolveUser(token);
}
function roleGuard(user, roles) {
  if (!user) return '请先登录';
  if (user.role === 'SYS_ADMIN') return null;
  if (roles && roles.length && !roles.includes(user.role)) return `当前角色(${user.role})无此操作权限，需要：${roles.join('/')}`;
  return null;
}
function err2(e) { return String((e && e.message) || e); }

async function staticFile(res, urlPath) {
  let p = path.normalize(path.join(__dirname, 'web', urlPath));
  const webRoot = path.normalize(path.join(__dirname, 'web'));
  if (!p.startsWith(webRoot)) return send(res, 403, { code: 403, message: 'forbidden' });
  if (p.endsWith(path.sep) || p === webRoot) p = path.join(p, 'index.html');
  if (!path.extname(p)) p = path.join(p, 'index.html');
  try {
    const buf = await fs.promises.readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch (e) {
    send(res, 404, { code: 404, message: '资源不存在' });
  }
}

// ---------- 路由注册 ----------
const routes = [];
function route(method, segs, handler, roles) { routes.push({ method, segs, handler, roles }); }
function match(urlSegs, spec) {
  if (urlSegs.length !== spec.length) return null;
  const p = {};
  for (let i = 0; i < spec.length; i++) {
    const s = spec[i];
    if (typeof s === 'object') { p[s.p] = urlSegs[i]; continue; }
    if (s !== urlSegs[i]) return null;
  }
  return p;
}

async function dispatch(req, res) {
  const u = new URL(req.url, 'http://x');
  const segs = u.pathname.split('/').filter(Boolean);
  const method = req.method;
  if (method === 'OPTIONS') return send(res, 200, {});
  // 根路径/静态资源走前端页面；仅 /api、/open 为后端接口
  if (!segs.length || (segs[0] !== 'api' && segs[0] !== 'open')) return staticFile(res, u.pathname);
  const found = routes.find((r) => r.method === method && match(segs, r.segs));
  if (!found) {
    // 开放 API 通配路由
    if (segs[0] === 'open' && segs[1] === 'v1' && method === 'GET' || (segs[0] === 'open' && segs[1] === 'v1' && method === 'POST')) {
      return openApiRoute(req, res, segs, u);
    }
    return send(res, 404, { code: 404, message: '接口不存在' });
  }
  const p = match(segs, found.segs);
  const user = uiUser(req);
  const isPublic = segs[0] === 'open' || found.segs.includes('login');
  if (!isPublic) {
    if (!user) return send(res, 401, { code: 401, message: '请先登录' });
    const g = roleGuard(user, found.roles);
    if (g) return send(res, 403, { code: 403, message: g });
  }
  let body = {};
  if (['POST', 'PUT'].includes(method) && req.headers['content-type'] && req.headers['content-type'].includes('json')) {
    try { body = await bodyParser(req); } catch (e) { return send(res, 400, { code: 400, message: err2(e) }); }
  }
  const q = Object.fromEntries(u.searchParams.entries());
  const ctx = { user, body, q, params: p || {}, req, res };
  try { await found.handler(ctx); } catch (e) { send(res, 500, { code: 500, message: err2(e) }); }
}

// ============ 认证 / 用户 ============
route('POST', ['api', 'auth', 'login'], async (c) => {
  const u = reg.get(`SELECT * FROM sys_user WHERE username=? AND enabled=1`, [c.body.username]);
  if (!u) return send(c.res, 401, { code: 401, message: '账号不存在或已停用' });
  const token = cryptoLib.uiToken(u);
  authMod.audit(u.username, u.role, '登录', 'session', '', '', c.req.socket.remoteAddress || '');
  send(c.res, 200, { code: 0, token, user: { username: u.username, name: u.display_name, role: u.role, expires_in: config.sessionMinutes * 60 } });
});
route('GET', ['api', 'auth', 'users'], async (c) => {
  const rows = reg.all(`SELECT username, display_name, role, phone FROM sys_user WHERE enabled=1`);
  send(c.res, 200, { code: 0, data: rows, roleLabel: reg.ROLE_LABEL });
});
route('GET', ['api', 'auth', 'me'], async (c) => send(c.res, 200, { code: 0, user: c.user }));
route('GET', ['api', 'auth', 'messages'], async (c) => send(c.res, 200, { code: 0, data: authMod.messages(c.user.username), unread: authMod.unreadCount(c.user.username) }));
route('POST', ['api', 'auth', 'messages', { p: 'id' }, 'read'], async (c) => { authMod.markRead(Number(c.params.id)); send(c.res, 200, { code: 0 }); });

// ============ 数据源状态 ============
route('GET', ['api', 'datasource', 'status'], async (c) => {
  const biz = await getBiz();
  const st = getStatus();
  const tables = await biz.listTables();
  send(c.res, 200, { code: 0, data: { actual: st.actual, message: st.message, name: biz.name, detail: biz.detail, tables, tableCount: tables.length, registryDb: config.registryDb, sessionMinutes: config.sessionMinutes } });
});

// ============ 一键初始化演示库 ============
route('POST', ['api', 'provision', 'demo'], async (c) => {
  const r = await provisionSvc.provisionDemo();
  send(c.res, 200, { code: 0, data: r, message: `已注册模型 ${r.models.length} 张，关系 ${r.relations.length} 条，函数 ${funcsSvc.listFuncs().length} 个` });
});

// ============ M3 模型管理 ============
route('GET', ['api', 'meta', 'tables'], async (c) => {
  const biz = await getBiz();
  const tables = await biz.listTables();
  const out = [];
  for (const t of tables) {
    const cat = seedDef(t);
    const regM = reg.get(`SELECT id, model_name, status FROM sys_model WHERE physical_table=?`, [t]);
    out.push({ table: t, cn: cat ? cat.cn : null, topic: cat ? cat.topic : null, registered: !!regM, modelId: regM ? regM.id : null, modelStatus: regM ? regM.status : null });
  }
  send(c.res, 200, { code: 0, data: out });
});
function seedDef(table) {
  const { TABLES } = require('./lib/seed');
  return TABLES.find((t) => t.table === table) || null;
}
route('GET', ['api', 'meta', 'read'], async (c) => {
  if (!c.q.table) return send(c.res, 400, { code: 400, message: '缺少table参数' });
  const biz = await getBiz();
  const exists = await biz.fetchColumns(c.q.table);
  if (!exists.length) return send(c.res, 404, { code: 404, message: '表中不存在或无访问权限' });
  const meta = await modelsSvc.metaReadTable(c.q.table);
  send(c.res, 200, { code: 0, data: meta });
});
route('GET', ['api', 'models', 'codes'], async (c) => send(c.res, 200, { code: 0, data: modelsSvc.listModelCodes() }));
route('GET', ['api', 'models'], async (c) => send(c.res, 200, { code: 0, data: modelsSvc.listModels() }));
route('GET', ['api', 'models', { p: 'id' }], async (c) => {
  const m = modelsSvc.getModel(Number(c.params.id));
  if (!m) return send(c.res, 404, { code: 404, message: '模型不存在' });
  send(c.res, 200, { code: 0, data: m });
});
route('POST', ['api', 'models'], async (c) => {
  const g = roleGuard(c.user, ['MODEL_ADMIN']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  if (!c.body.physicalTable) return send(c.res, 400, { code: 400, message: '缺少物理表' });
  const dup = reg.get(`SELECT id FROM sys_model WHERE physical_table=?`, [c.body.physicalTable]);
  if (dup) return send(c.res, 400, { code: 400, message: '该物理表已注册为数据模型' });
  const r = modelsSvc.registerModel(c.body, c.user);
  send(c.res, 200, { code: 0, data: r, message: '已保存草稿，补齐业务属性并确认敏感字段后可发布' });
});
route('PUT', ['api', 'models', { p: 'id' }], async (c) => { send(c.res, 200, { code: 0, data: modelsSvc.updateModel(Number(c.params.id), c.body, c.user) }); });
route('POST', ['api', 'models', { p: 'id' }, 'sync'], async (c) => {
  const r = await modelsSvc.syncModelMeta(Number(c.params.id), c.user);
  send(c.res, 200, { code: 0, data: r });
});
route('POST', ['api', 'models', { p: 'id' }, 'status'], async (c) => {
  const id = Number(c.params.id);
  const status = c.body.status;
  const m = modelsSvc.getModel(id);
  if (!m) return send(c.res, 404, { code: 404, message: '模型不存在' });
  const approverLike = approvalsSvc.canApprove(c.user);
  if (status === 'PUBLISHED' && !approverLike) {
    const r = approvalsSvc.submitOrAct('MODEL_PUBLISH', 'model', id, { model_id: id, model_name: m.model_name }, c.user.username, c.user);
    modelsSvc.setModelStatus(id, r.need ? 'DRAFT' : 'PUBLISHED', c.user); // 待审模型保持DRAFT以提示
    return send(c.res, 200, { code: 0, data: { need: r.need, message: r.need ? '已提交发布审批' : '已发布' } });
  }
  modelsSvc.setModelStatus(id, status, c.user);
  send(c.res, 200, { code: 0, data: modelsSvc.getModel(id) });
});
route('GET', ['api', 'models', { p: 'id' }, 'preview'], async (c) => {
  const r = await modelsSvc.previewModel(Number(c.params.id), { n: parseInt(c.q.n || '100', 10) }, c.user);
  send(c.res, 200, { code: 0, data: r });
});
route('POST', ['api', 'models', { p: 'id' }, 'mask-sample'], async (c) => {
  const r = await modelsSvc.maskSample(Number(c.params.id), Number(c.body.fieldId), { role: c.user.role });
  send(c.res, 200, { code: 0, data: r });
});
route('PUT', ['api', 'fields', { p: 'id' }], async (c) => {
  const g = roleGuard(c.user, ['MODEL_ADMIN', 'APPROVER', 'SECURITY_ADMIN']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  send(c.res, 200, { code: 0, data: modelsSvc.updateField(Number(c.params.id), c.body, c.user) });
});

// ============ 模型关系 F3-4 ============
route('GET', ['api', 'relations'], async (c) => send(c.res, 200, { code: 0, data: modelsSvc.listRelations() }));
route('GET', ['api', 'relations', 'graph'], async (c) => send(c.res, 200, { code: 0, data: modelsSvc.relationGraph() }));
route('GET', ['api', 'recommend'], async (c) => {
  const ids = String(c.q.modelIds || '').split(',').map(Number).filter(Boolean);
  send(c.res, 200, { code: 0, data: modelsSvc.recommendFor(ids) });
});
route('POST', ['api', 'relations'], async (c) => {
  const g = roleGuard(c.user, ['MODEL_ADMIN', 'APPROVER', 'SECURITY_ADMIN']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  const r = modelsSvc.createRelation(c.body, c.user);
  send(c.res, 200, { code: 0, data: r, message: '关系已创建，可在“模型关系管理”中启用' });
});
route('POST', ['api', 'relations', 'validate'], async (c) => {
  const r = await modelsSvc.validateRelation(c.body);
  send(c.res, 200, { code: 0, data: r });
});
route('POST', ['api', 'relations', { p: 'id' }, 'status'], async (c) => {
  send(c.res, 200, { code: 0, data: modelsSvc.setRelationStatus(Number(c.params.id), c.body.status, c.user) });
});
route('DELETE', ['api', 'relations', { p: 'id' }], async (c) => { modelsSvc.removeRelation(Number(c.params.id), c.user); send(c.res, 200, { code: 0 }); });

// ============ 自定义函数 F1-5 ============
route('GET', ['api', 'funcs'], async (c) => send(c.res, 200, { code: 0, data: funcsSvc.listFuncs() }));
route('POST', ['api', 'funcs'], async (c) => { const r = funcsSvc.createFunc(c.body, c.user); send(c.res, 200, { code: 0, data: r }); });
route('PUT', ['api', 'funcs', { p: 'id' }], async (c) => send(c.res, 200, { code: 0, data: funcsSvc.updateFunc(Number(c.params.id), c.body, c.user) }));
route('POST', ['api', 'funcs', { p: 'id' }, 'test'], async (c) => {
  const r = funcsSvc.testFunc(Number(c.params.id), c.body.args, c.user);
  send(c.res, 200, { code: 0, data: r });
});
route('POST', ['api', 'funcs', { p: 'id' }, 'status'], async (c) => send(c.res, 200, { code: 0, data: funcsSvc.setFuncStatus(Number(c.params.id), c.body.status, c.user) }));
route('DELETE', ['api', 'funcs', { p: 'id' }], async (c) => { funcsSvc.removeFunc(Number(c.params.id), c.user); send(c.res, 200, { code: 0 }); });
route('GET', ['api', 'funcs', { p: 'id' }, 'usage'], async (c) => send(c.res, 200, { code: 0, data: funcsSvc.usage(Number(c.params.id)) }));

// ============ 组合分析流程 ============
route('GET', ['api', 'flows'], async (c) => send(c.res, 200, { code: 0, data: tasksSvc.listFlows() }));
route('GET', ['api', 'flows', { p: 'id' }], async (c) => {
  const f = tasksSvc.getFlow(Number(c.params.id));
  if (!f) return send(c.res, 404, { code: 404, message: '流程不存在' });
  send(c.res, 200, { code: 0, data: f });
});
route('POST', ['api', 'flows'], async (c) => send(c.res, 200, { code: 0, data: tasksSvc.saveFlow(c.body, c.user) }));
route('DELETE', ['api', 'flows', { p: 'id' }], async (c) => { tasksSvc.deleteFlow(Number(c.params.id), c.user); send(c.res, 200, { code: 0 }); });

route('GET', ['api', 'analysis', 'meta'], async (c) => {
  const ids = String(c.q.modelIds || '').split(',').map(Number).filter(Boolean);
  const models = ids.map((id) => modelsSvc.getModel(id)).filter(Boolean);
  const rels = modelsSvc.recommendFor(ids);
  const funcs = funcsSvc.listFuncs().filter((f) => f.status === 'PUBLISHED');
  send(c.res, 200, { code: 0, data: { models, relations: rels, funcs } });
});
route('POST', ['api', 'analysis', 'validate'], async (c) => {
  const engine = require('./lib/engine');
  const modelInfos = (c.body.models || []).map((id) => modelsSvc.getModel(id));
  const issues = engine.validate(c.body.config || c.body, modelInfos);
  send(c.res, 200, { code: 0, data: { issues } });
});
route('POST', ['api', 'analysis', 'preview'], async (c) => {
  // until：-1 表示全部；用于“执行到某一步”
  const r = await tasksSvc.preview(c.body.config, c.body.until == null ? 9999 : Number(c.body.until), c.body.role || c.user.role);
  send(c.res, 200, { code: 0, data: r });
});

// ============ 取数任务 F1-7 ============
route('GET', ['api', 'tasks'], async (c) => send(c.res, 200, { code: 0, data: tasksSvc.listTasks() }));
route('GET', ['api', 'tasks', { p: 'id' }], async (c) => {
  const t = tasksSvc.getTask(Number(c.params.id));
  if (!t) return send(c.res, 404, { code: 404, message: '任务不存在' });
  send(c.res, 200, { code: 0, data: t });
});
route('POST', ['api', 'tasks'], async (c) => send(c.res, 200, { code: 0, data: tasksSvc.createTask(c.body, c.user) }));
route('POST', ['api', 'tasks', { p: 'id' }, 'run'], async (c) => {
  const r = await tasksSvc.runTaskNow(Number(c.params.id), c.user);
  send(c.res, 200, { code: 0, data: r, message: r.ok ? '任务已提交并执行完成' : ('执行失败：' + r.error) });
});
route('POST', ['api', 'tasks', { p: 'id' }, 'terminate'], async (c) => {
  const t = tasksSvc.terminateTask(Number(c.params.id), c.user);
  send(c.res, 200, { code: 0, data: t });
});
route('DELETE', ['api', 'tasks', { p: 'id' }], async (c) => { tasksSvc.deleteTask(Number(c.params.id), c.user); send(c.res, 200, { code: 0 }); });
route('GET', ['api', 'runs', { p: 'id' }], async (c) => {
  const r = tasksSvc.getRun(Number(c.params.id));
  if (!r) return send(c.res, 404, { code: 404, message: '运行记录不存在' });
  const cols = (r.payload.columns || []).slice(0, 500);
  const rows = (r.payload.rows || []).slice(0, 5000);
  // 服务端按当前角色统一脱敏（与预览/导出/API形态一致，不可绕过）
  const masked = require('./lib/engine').maskRows(rows, cols, c.user.role);
  send(c.res, 200, { code: 0, data: { id: r.id, task_id: r.task_id, run_no: r.run_no, status: r.status, row_count: r.row_count, duration_ms: r.duration_ms, created_at: r.created_at, finished_at: r.finished_at, error: r.error, columns: cols, rows: masked, sql: r.payload.sql } });
});
route('DELETE', ['api', 'runs', { p: 'id' }], async (c) => { tasksSvc.deleteRun(Number(c.params.id)); send(c.res, 200, { code: 0 }); });
route('GET', ['api', 'runs', { p: 'id' }, 'export'], async (c) => {
  const r = tasksSvc.getRun(Number(c.params.id));
  if (!r || !r.payload.rows) return send(c.res, 404, { code: 404, message: '结果不存在' });
  const { columns, rows } = r.payload;
  const role = c.user.role;
  if (rows.length > 10000 && !approvalsSvc.canApprove(c.user)) return send(c.res, 403, { code: 403, message: '导出超过行数阈值，需审批' });
  const sens = columns.filter((x) => x.sens).length;
  if (sens && !approvalsSvc.canApprove(c.user)) return send(c.res, 403, { code: 403, message: '结果含敏感字段，导出需由审核人员审批后执行' });
  const masked = require('./lib/engine').maskRows(rows, columns, role);
  const head = columns.map((x) => `${x.cn || x.alias}[${x.alias}]`);
  const lines = [head.join(',')];
  for (const row of masked) lines.push(columns.map((x) => CSV(row[x.alias])).join(','));
  const buf = '\ufeff' + lines.join('\r\n');
  authMod.audit(c.user.username, c.user.role, '结果导出', 'run', r.id, `${rows.length}行`);
  c.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="result_' + r.id + '.csv"' });
  c.res.end(buf);
});
function CSV(v) { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

// ============ 开放 API F2 ============
route('GET', ['api', 'open', 'apis'], async (c) => send(c.res, 200, { code: 0, data: openSvc.listApis() }));
route('POST', ['api', 'open', 'apis'], async (c) => {
  const g = roleGuard(c.user, ['ANALYST', 'APPROVER', 'SECURITY_ADMIN']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  send(c.res, 200, { code: 0, data: openSvc.openAsApi(c.body, c.user) });
});
route('GET', ['api', 'open', 'apis', { p: 'id' }], async (c) => {
  const a = openSvc.getApi(Number(c.params.id));
  if (!a) return send(c.res, 404, { code: 404, message: 'API不存在' });
  send(c.res, 200, { code: 0, data: a });
});
route('PUT', ['api', 'open', 'apis', { p: 'id' }], async (c) => send(c.res, 200, { code: 0, data: openSvc.updateApi(Number(c.params.id), c.body, c.user) }));
route('POST', ['api', 'open', 'apis', { p: 'id' }, 'publish'], async (c) => {
  const r = openSvc.requestPublishApi(Number(c.params.id), c.user);
  send(c.res, 200, { code: 0, data: r, message: r.message });
});
route('POST', ['api', 'open', 'apis', { p: 'id' }, 'offline'], async (c) => {
  const r = openSvc.offlineApi(Number(c.params.id), c.user);
  send(c.res, 200, { code: 0, data: r, message: r.message });
});
route('POST', ['api', 'open', 'apis', { p: 'id' }, 'debug'], async (c) => {
  const api = openSvc.getApi(Number(c.params.id));
  if (!api) return send(c.res, 404, { code: 404, message: 'API不存在' });
  const res = openSvc.executeCall(api, null, null, c.body.params || {}, { debug: true, ip: c.req.socket.remoteAddress });
  if (!res.ok) return send(c.res, res.code >= 400 ? res.code : 400, { code: res.code, message: res.message });
  send(c.res, 200, { code: 0, data: res.data, latency: res.latency });
});
route('GET', ['api', 'open', 'apis', { p: 'id' }, 'stats'], async (c) => {
  const rows = reg.all(`SELECT * FROM sys_call_log WHERE api_id=? ORDER BY id DESC LIMIT 50`, [Number(c.params.id)]);
  send(c.res, 200, { code: 0, data: rows });
});

route('GET', ['api', 'open', 'apps'], async (c) => send(c.res, 200, { code: 0, data: openSvc.listApps() }));
route('POST', ['api', 'open', 'apps'], async (c) => {
  const g = roleGuard(c.user, ['SECURITY_ADMIN', 'SYS_ADMIN', 'APPROVER']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  send(c.res, 200, { code: 0, data: openSvc.createApp(c.body, c.user) });
});
route('POST', ['api', 'open', 'apps', { p: 'id' }, 'reset-secret'], async (c) => {
  const g = roleGuard(c.user, ['SECURITY_ADMIN', 'SYS_ADMIN', 'APPROVER']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  send(c.res, 200, { code: 0, data: openSvc.regenSecret(Number(c.params.id), c.user) });
});
route('POST', ['api', 'open', 'apps', { p: 'id' }, 'status'], async (c) => {
  const g = roleGuard(c.user, ['SECURITY_ADMIN', 'SYS_ADMIN', 'APPROVER']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  send(c.res, 200, { code: 0, data: openSvc.setAppStatus(Number(c.params.id), c.body.status, c.user) });
});
route('POST', ['api', 'open', 'apps', { p: 'id' }, 'pubkey'], async (c) => {
  send(c.res, 200, { code: 0, data: openSvc.registerPubKey(Number(c.params.id), c.body.jwk, c.user) });
});

route('GET', ['api', 'open', 'authz'], async (c) => send(c.res, 200, { code: 0, data: openSvc.listAuthz() }));
route('POST', ['api', 'open', 'authz'], async (c) => {
  const g = roleGuard(c.user, ['SECURITY_ADMIN', 'APPROVER', 'SYS_ADMIN']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  send(c.res, 200, { code: 0, data: openSvc.createAuthz(c.body, c.user) });
});
route('POST', ['api', 'open', 'authz', { p: 'id' }, 'revoke'], async (c) => {
  const g = roleGuard(c.user, ['SECURITY_ADMIN', 'APPROVER', 'SYS_ADMIN']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  send(c.res, 200, { code: 0, data: openSvc.revokeAuthz(Number(c.params.id), c.user) });
});
route('GET', ['api', 'open', 'logs'], async (c) => send(c.res, 200, { code: 0, data: openSvc.listCallLogs(c.q) }));
route('GET', ['api', 'open', 'monitor'], async (c) => send(c.res, 200, { code: 0, data: openSvc.apiMonitor() }));

// ============ 审批 ============
route('GET', ['api', 'approvals', 'pending'], async (c) => {
  const list = approvalsSvc.listPending();
  const out = list.map((a) => decorateApproval(a));
  send(c.res, 200, { code: 0, data: out });
});
route('GET', ['api', 'approvals', 'all'], async (c) => send(c.res, 200, { code: 0, data: approvalsSvc.listAll() }));
route('POST', ['api', 'approvals', { p: 'id' }, 'act'], async (c) => {
  const g = roleGuard(c.user, ['APPROVER', 'SECURITY_ADMIN', 'SYS_ADMIN']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  const a = approvalsSvc.act(Number(c.params.id), !!c.body.approve, c.user, c.body.reason);
  const r = decorateApproval(a);
  // 站内消息通知申请方
  if (a.proposer) authMod.notify(a.proposer, '审批结果通知', `您的审批单(${a.type})${c.body.approve ? '已通过' : '已驳回'}`);
  send(c.res, 200, { code: 0, data: r });
});
function decorateApproval(a) {
  let extra = {};
  try {
    if (a.type === 'API_PUBLISH' || a.type === 'API_OFFLINE') extra = openSvc.getApi(a.ref_id) || {};
    if (a.type === 'MODEL_PUBLISH') extra = modelsSvc.getModel(a.ref_id) || {};
  } catch (e) { extra = {}; }
  return { ...a, ref: extra };
}

// ============ 审计日志 ============
route('GET', ['api', 'audit'], async (c) => {
  const g = roleGuard(c.user, ['SECURITY_ADMIN', 'SYS_ADMIN', 'APPROVER']);
  if (g) return send(c.res, 403, { code: 403, message: g });
  let sql = `SELECT * FROM sys_audit WHERE 1=1`;
  const p = [];
  if (c.q.action) { sql += ' AND action LIKE ?'; p.push('%' + c.q.action + '%'); }
  if (c.q.actor) { sql += ' AND actor=?'; p.push(c.q.actor); }
  if (c.q.objectType) { sql += ' AND object_type=?'; p.push(c.q.objectType); }
  sql += ' ORDER BY id DESC LIMIT 300';
  send(c.res, 200, { code: 0, data: reg.all(sql, p) });
});

// ============ 对外开放接口（F2-2/F2-3） ============
route('POST', ['open', 'oauth', 'token'], async (c) => {
  const { appKey, appSecret } = c.body;
  if (!appKey || !appSecret) return send(c.res, 400, { code: 400, message: '缺少AppKey/AppSecret' });
  const app = openSvc.getAppByKey(appKey);
  if (!app || app.status !== 'ACTIVE') return send(c.res, 401, { code: 401, message: '应用凭证无效或已被吊销' });
  const h = cryptoLib.hashSecret(appSecret);
  if (h !== app.secret_hash) return send(c.res, 401, { code: 401, message: 'AppSecret错误' });
  openSvc.logCall({ app, api: null, ok: true, statusCode: 200, params: { appKey }, latency: 0, ip: c.req.socket.remoteAddress, error: '' });
  send(c.res, 200, { code: 0, data: { access_token: cryptoLib.openToken(app), token_type: 'Bearer', expires_in: config.sessionMinutes * 60 } });
});

function normalizeOpenToken(c) {
  const h = c.req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (c.q.token || '');
}

async function openApiRoute(req, res, segs, u) {
  const path = '/' + segs.join('/');
  const api = openSvc.getApiByPath(path);
  if (!api) return send(res, 404, { code: 404, message: '接口不存在' });
  if (api.status !== 'PUBLISHED') return send(res, 403, { code: 403, message: api.status === 'OFFLINE' ? '接口已下线' : '接口未发布或未上线' });
  const body = req.method === 'POST' ? await bodyParser(req).catch(() => ({})) : {};
  const q = Object.fromEntries(u.searchParams.entries());
  const token = (req.headers.authorization || '').startsWith('Bearer ') ? req.headers.authorization.slice(7) : q.token;
  const claims = cryptoLib.verifyOpen(token);
  if (!claims) return send(res, 401, { code: 401, message: '令牌无效或已过期(令牌有效期不超过30分钟)，请重新获取' });
  const app = openSvc.getApp(Number(claims.app));
  if (!app || app.status !== 'ACTIVE') return send(res, 401, { code: 401, message: '凭证已吊销' });
  const authz = reg.get(`SELECT * FROM sys_authorization WHERE app_id=? AND api_id=? AND status='ACTIVE'`, [app.id, api.id]);
  if (!authz) return send(res, 403, { code: 403, message: '该应用未被授权访问此接口' });
  const limitMsg = openSvc.checkRate(api, app.id);
  if (limitMsg) return send(res, 429, { code: 429, message: '调用频率超限：' + limitMsg });
  const paramsObj = { ...q, ...body };
  const start = Date.now();
  const r = openSvc.executeCall(api, app, authz, paramsObj, { ip: req.socket.remoteAddress });
  openSvc.logCall({ app, api, ok: r.ok, statusCode: r.code === 0 ? 200 : (r.code || 500), params: paramsObj, latency: r.latency != null ? r.latency : Date.now() - start, ip: req.socket.remoteAddress, error: r.message || '' });
  if (!r.ok) return send(res, r.code >= 400 ? r.code : 400, { code: r.code, message: r.message });
  if (r.encrypted) {
    send(res, 200, { code: 0, message: 'ok', encrypted: true, alg: r.alg, env: r.env });
  } else {
    send(res, 200, { code: 0, message: 'ok', data: r.data, latency: r.latency });
  }
}

// ---------- 启动 ----------
async function main() {
  reg.openRegistry();
  await initBusiness();
  funcsSvc.ensureBuiltins();
  // 首次启动：自动注册 11 张演示模型 + 关系（演示开箱即用；已注册则跳过）
  if (process.env.DEMO_AUTO_PROVISION !== '0') {
    const modelCnt = reg.get(`SELECT COUNT(*) c FROM sys_model`).c;
    if (!modelCnt) {
      const r = await provisionSvc.provisionDemo();
      console.log('  [自动初始化] 已注册演示模型', r.models.length, '张，关系', r.relations.length, '条');
    }
  }
  tasksSvc.startScheduler();
  const server = http.createServer((req, res) => dispatch(req, res).catch((e) => send(res, 500, { code: 500, message: err2(e) })));
  server.listen(config.server.port, config.server.host, () => {
    console.log('='.repeat(70));
    console.log(' 客户声音掘金 · 数据组合分析及开放能力 Demo 已启动');
    console.log(' 访问地址   : http://127.0.0.1:' + config.server.port);
    const st = getStatus();
    console.log(' 业务数据源 : ' + st.actual + ' —— ' + (st.message || ''));
    if (st.actual === 'sqlite') console.log('   (如需连接远程 MySQL：npm install mysql2 并配置 config.js business.mysql)');
    console.log(' 注册表     : ' + config.registryDb);
    console.log('='.repeat(70));
  });
}
if (require.main === module) {
  main().catch((e) => { console.error('启动失败:', e); process.exit(1); });
}

module.exports = { dispatch, route, send, bodyParser, uiUser, roleGuard, openApiRoute, main };
