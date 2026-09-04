/** HTTP 契约级自测：无网络端口，模拟 req/res 直接驱动 server.dispatch，覆盖主要REST与开放接口全链路 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
process.env.DEMO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sjdemo_'));
process.env.DEMO_AUTO_PROVISION = '0';
const crypto = require('crypto');

const reg = require('../lib/registry');
const biz = require('../lib/biz');
const funcs = require('../lib/services/funcs');
const provision = require('../lib/services/provision');
const cryptoLib = require('../lib/crypto');
const srv = require('../server');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗ FAIL:', name, extra); } }

class FakeRes {
  constructor() { this.status = 200; this.headers = {}; this.body = ''; }
  writeHead(code, h) { this.status = code; this.headers = Object.assign(this.headers, h); }
  end(b) { this.body = b ? b.toString('utf8') : ''; }
}
class FakeReq {
  constructor(method, url, body, headers) {
    this.method = method; this.url = url;
    this.headers = Object.assign({}, headers);
    this.socket = { remoteAddress: '127.0.0.1' };
    if (body !== undefined) this.headers['content-type'] = 'application/json';
    this._body = body; this._handlers = {};
  }
  on(ev, fn) {
    this._handlers[ev] = fn;
    if (ev === 'end') {
      setImmediate(() => {
        if (this._body !== undefined) {
          const chunk = Buffer.from(typeof this._body === 'string' ? this._body : JSON.stringify(this._body), 'utf8');
          if (this._handlers.data) this._handlers.data(chunk);
        }
        if (this._handlers.end) this._handlers.end();
      });
    }
    return this;
  }
}
async function call(method, url, token, body) {
  const res = new FakeRes();
  const req = new FakeReq(method, url, body, token ? { authorization: 'Bearer ' + token } : {});
  await srv.dispatch(req, res);
  let j = null;
  try { j = JSON.parse(res.body); } catch (e) { j = { raw: res.body.slice(0, 500) }; }
  return { status: res.status, json: j, body: res.body };
}

async function main() {
  console.log('\n[setup] 干净环境初始化');
  reg.openRegistry();
  await biz.initBusiness();
  funcs.ensureBuiltins();
  await provision.provisionDemo();

  console.log('\n[1] 登录与基础接口');
  const ana = await call('POST', '/api/auth/login', null, { username: 'analyst' });
  ok('分析师登录', ana.status === 200 && ana.json.code === 0);
  const A = ana.json.token;
  const appr = await call('POST', '/api/auth/login', null, { username: 'approver' });
  const AP = appr.json.token;
  const sec = await call('POST', '/api/auth/login', null, { username: 'security_admin' });
  const S = sec.json.token;
  const ds = await call('GET', '/api/datasource/status', A);
  ok('数据源状态接口', ds.json.code === 0 && ds.json.data.tableCount === 11, ds.json.data && ds.json.data.tableCount);
  const home = await call('GET', '/');
  ok('根路径返回前端页面(200)', home.status === 200 && home.body.includes('客户声音掘金'), 'status=' + home.status + ' len=' + home.body.length);
  const models = await call('GET', '/api/models/codes', A);
  const byPhys = {};
  for (const m of models.json.data) byPhys[m.physical_table] = m.id;

  console.log('\n[2] 组合分析流程（REST：校验/预览/保存）');
  const ids = ['sj_customer_profile', 'sj_plan_order', 'sj_cust_complaint', 'sj_cust_traffic_usage'].map((t) => byPhys[t]);
  const rel = await call('GET', '/api/recommend?modelIds=' + ids.join(','), A);
  const joins = rel.json.data.map((r) => ({ type: r.rel_type, left: { model: r.left_model_id, fields: JSON.parse(r.left_fields) }, right: { model: r.right_model_id, fields: JSON.parse(r.right_fields) } }));
  const cfg = {
    models: ids, joins,
    steps: [
      { type: 'filter', conditions: [{ field: 'plan_name', op: 'contains', value: '主副卡' }], logic: 'and' },
      { type: 'filter', conditions: [{ field: 'complaint_type_code', op: 'eq', value: 'FL' }], logic: 'and' },
      { type: 'aggregate', group: ['province_code', 'stat_month'], aggs: [
        { alias: '超套流量合计', field: 'over_traffic', op: 'sum', decimal: 2 },
        { alias: '月均实际', field: 'actual_traffic', op: 'avg', decimal: 2 },
        { alias: '投诉量', field: 'id', op: 'count' }] },
      { type: 'calc', exprs: [{ alias: '超套占比', expr: '({超套流量合计} / {月均实际}) * 100', decimal: 2 }] },
      { type: 'sort', sort: [{ field: '投诉量', dir: 'desc' }], topN: 5 },
    ],
  };
  const v = await call('POST', '/api/analysis/validate', A, { config: cfg });
  ok('流程校验接口通过', v.json.code === 0 && v.json.data.issues.length === 0, JSON.stringify(v.json.data && v.json.data.issues));
  const pv = await call('POST', '/api/analysis/preview', A, { config: cfg });
  ok('流程预览返回数据', pv.json.code === 0 && pv.json.data.total > 0, 'total=' + (pv.json.data && pv.json.data.total));
  const aggFields = (pv.json.data.columns || []).some((c) => c.alias === '超套流量合计' && c.agg);
  const derivedFields = (pv.json.data.columns || []).some((c) => c.alias === '超套占比' && c.expr);
  ok('预览含聚合列', aggFields);
  ok('预览含派生列(表达式可见)', derivedFields);
  // 回归：until=-1 必须执行全部步骤（筛选/聚合生效），不能退化成原始100行
  const baseAll = await call('POST', '/api/analysis/preview', A, { config: { models: ids, joins, steps: [] } });
  const runAll = await call('POST', '/api/analysis/preview', A, { config: cfg, until: -1 });
  ok('until=-1 时步骤全部生效且行数下降', runAll.json.code === 0 && runAll.json.data.total > 0 && runAll.json.data.total < baseAll.json.data.total,
    'base=' + (baseAll.json.data && baseAll.json.data.total) + ' filtered=' + (runAll.json.data && runAll.json.data.total));
  const pvPhone = await call('POST', '/api/analysis/preview', A, { config: { models: ids.slice(0, 2), joins: joins.filter((j) => j.left.model === ids[0] || j.right.model === ids[0]), steps: [] } });
  const hasMask = (pvPhone.json.data.rows || []).slice(0, 5).some((r) => String(r.phone || '').includes('*'));
  ok('明细预览输出手机号已脱敏', hasMask);
  const fw = await call('POST', '/api/flows', A, { flow_name: '契约测试流程', config: cfg });
  ok('保存流程', fw.json.code === 0 && fw.json.data.id > 0);
  const flowId = fw.json.data.id;

  console.log('\n[3] 任务即时执行');
  const tk = await call('POST', '/api/tasks', A, { flow_id: flowId, task_name: '契约测试任务', exec_type: 'ONCE', retry: 0 });
  ok('创建任务', tk.json.code === 0);
  const tkId = tk.json.data.id;
  const run = await call('POST', '/api/tasks/' + tkId + '/run', A);
  ok('任务执行成功', run.json.code === 0 && run.json.data.ok);
  const td = await call('GET', '/api/tasks/' + tkId, A);
  ok('任务状态=SUCCESS', td.json.data.status === 'SUCCESS');
  const runId = td.json.data.runs[0].id;
  const rd = await call('GET', '/api/runs/' + runId, A);
  ok('结果接口(脱敏)返回', rd.json.code === 0 && rd.json.data.row_count > 0);

  console.log('\n[4] 开放API全链路（创建→审批→授权→令牌→加密调用）');
  const api = await call('POST', '/api/open/apis', A, { run_id: runId, api_name: '契约测试API', api_path: 'contract_test_' + Date.now(), param_defs: [{ name: 'province', column: 'province_code' }], return_struct: 'BOTH', sample_count: 50, page_size: 100, limit_per_sec: 100, limit_per_day: 10000, encrypt: 1 });
  ok('创建API草稿', api.json.code === 0 && api.json.data.id > 0);
  const apiId = api.json.data.id;
  const pubR = await call('POST', '/api/open/apis/' + apiId + '/publish', AP);
  ok('审核人员直接发布API', pubR.json.data.need === false);
  // 审批单应无遗留
  const pend = await call('GET', '/api/approvals/pending', AP);
  ok('无遗留待审批', pend.json.data.filter((a) => a.status === 'PENDING').length === 0);

  const app = await call('POST', '/api/open/apps', S, { app_name: '契约测试应用' });
  ok('创建应用', app.json.code === 0);
  const { appKey, appSecret, id: appId } = app.json.data;
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const pubJwk = crypto.createPublicKey(kp.publicKey).export({ format: 'jwk' });
  await call('POST', '/api/open/apps/' + appId + '/pubkey', S, { jwk: pubJwk });
  const az = await call('POST', '/api/open/authz', S, { app_id: appId, api_id: apiId, data_scope: {}, field_scope: [] });
  ok('建立授权关系', az.json.code === 0);

  // 令牌
  const tok = await call('POST', '/open/oauth/token', null, { appKey, appSecret });
  ok('换取访问令牌', tok.json.code === 0 && tok.json.data.access_token);
  const access = tok.json.data.access_token;

  const path2 = (await call('GET', '/api/open/apis', A)).json.data.find((x) => x.id === apiId).api_path;
  const naked = await call('GET', path2 + '?page=1');
  ok('未携带令牌调用被拒401', naked.status === 401);
  // 先建第二个未授权应用看403
  const app2 = await call('POST', '/api/open/apps', S, { app_name: '未授权应用' });
  const tok2 = await call('POST', '/open/oauth/token', null, { appKey: app2.json.data.appKey, appSecret: app2.json.data.appSecret });
  const f403 = await call('GET', path2 + '?token=' + tok2.json.data.access_token + '&page=1');
  ok('未授权应用调用被拒403', f403.status === 403, 'status=' + f403.status);
  const enc = await call('GET', path2 + '?token=' + access + '&page=1');
  ok('授权调用成功(加密返回)', enc.status === 200 && enc.json.encrypted === true);
  const privJwk = crypto.createPrivateKey(kp.privateKey).export({ format: 'jwk' });
  const plain = cryptoLib.hybridDecrypt(privJwk, enc.json.env);
  ok('解密还原数据(总量一致)', plain.code === 0 && plain.data && typeof plain.data.total === 'number' && plain.data.total > 0);
  const logs = await call('GET', '/api/open/logs', A);
  ok('调用日志记录', logs.json.data.length >= 2);

  console.log('\n[5] 脱敏差异/导出审批/审计');
  const exSum = await call('GET', '/api/runs/' + runId + '/export', A);
  ok('非敏感汇总结果分析师可直接导出CSV', exSum.status === 200 && exSum.body.indexOf(',') > 0);
  // 含敏感字段的明细结果导出需审批（用含手机号的明细流程验证）
  const fwd = await call('POST', '/api/flows', A, { flow_name: '导出审批明细(含手机号)', config: { models: ids.slice(0, 2), joins, steps: [] } });
  const tkd = await call('POST', '/api/tasks', A, { flow_id: fwd.json.data.id, task_name: '导出审批明细任务', exec_type: 'ONCE' });
  await call('POST', '/api/tasks/' + tkd.json.data.id + '/run', A);
  const tdd = await call('GET', '/api/tasks/' + tkd.json.data.id, A);
  const runDetId = tdd.json.data.runs[0].id;
  const exA = await call('GET', '/api/runs/' + runDetId + '/export', A);
  ok('含敏感结果导出需审批(分析师403)', exA.status === 403);
  const exP = await call('GET', '/api/runs/' + runDetId + '/export', AP);
  ok('审核人员可导出CSV', exP.status === 200 && exP.body.indexOf(',') > 0);
  const aus = await call('GET', '/api/audit', S);
  ok('审计日志可查询', aus.json.code === 0 && aus.json.data.length > 10);

  console.log('\n==================== HTTP契约自测：通过 ' + pass + '，失败 ' + fail + ' ====================');
  try { fs.rmSync(process.env.DEMO_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
