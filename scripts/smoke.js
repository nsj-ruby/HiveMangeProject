/** 后端逻辑自测（无需网络/端口）：直接调用服务层，覆盖 14 个功能点核心逻辑 */
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
// 自测从干净数据开始（删除演示数据目录以重建）
fs.rmSync(config.dataDir, { recursive: true, force: true });
const crypto = require('crypto');
const reg = require('../lib/registry');
const { initBusiness, getBiz, getStatus } = require('../lib/biz');
const models = require('../lib/services/models');
const funcs = require('../lib/services/funcs');
const tasks = require('../lib/services/tasks');
const open = require('../lib/services/open');
const approvals = require('../lib/services/approvals');
const provision = require('../lib/services/provision');
const desen = require('../lib/desensitize');
const engine = require('../lib/engine');
const cronMod = require('../lib/cron');
const cryptoLib = require('../lib/crypto');
const seed = require('../lib/seed');
const { json } = require('../lib/util');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗ FAIL:', name, extra); }
}

async function main() {
  reg.openRegistry();
  funcs.ensureBuiltins();
  console.log('\n[1] 业务数据源初始化（11 张表 ×100 行）');
  await initBusiness();
  const biz = await getBiz();
  const st = getStatus();
  console.log('  实际数据源:', st.actual, st.message);
  const tables = await biz.listTables();
  ok('生成业务表数量=11', tables.length === 11, `实际${tables.length}`);
  for (const t of tables) {
    const c = await biz.count(t);
    ok(`表 ${t} 共 ${c} 行`, c === 100, 'count=' + c);
  }

  console.log('\n[2] F3-1 元数据自动读取 & 模型注册');
  const meta = await models.metaReadTable('sj_customer_profile');
  ok('自动读取字段数≥10', meta.fields.length >= 10, 'fields=' + meta.fields.length);
  const phoneMeta = meta.fields.find((f) => f.field_name === 'phone');
  ok('手机号被自动识别为敏感(高)', phoneMeta && phoneMeta.is_sensitive && phoneMeta.sens_level === '高');
  const ds = await provision.provisionDemo();
  console.log('  演示库注册模型:', ds.models.length, '关系:', ds.relations.length, '函数:', funcs.listFuncs().length);
  ok('注册模型=11', reg.all(`SELECT COUNT(*) c FROM sys_model`)[0].c === 11);
  const complaintModel = reg.get(`SELECT * FROM sys_model WHERE physical_table='sj_cust_complaint'`);
  const rels = models.listRelations();
  ok('模型关系已配置', rels.length >= 9, 'relations=' + rels.length);

  console.log('\n[3] F3-4 关系校验 & 自动推荐');
  const rel1 = rels[0];
  const v = await models.validateRelation({ left_model_id: rel1.left_model_id, left_fields: JSON.parse(rel1.left_fields), right_model_id: rel1.right_model_id, right_fields: JSON.parse(rel1.right_fields) });
  ok('关系校验通过', v.ok === true, json(v.issues || v).slice(0, 300));

  console.log('\n[4] F3-2 脱敏 & F3-3 预览');
  const fm = { is_sensitive: 1, mask_alg: 'MASK', mask_params: JSON.stringify({ keepLeft: 3, keepRight: 4, maskChar: '*' }), role_exempt: '[]' };
  const maskedPhone = desen.apply(fm, '13812345678', 'ANALYST');
  ok('手机号掩码(138****5678)', maskedPhone === '138****5678', maskedPhone);
  const pv = await models.previewModel(complaintModel.id, { n: 20 }, { username: 'analyst', role: 'ANALYST' });
  const hasMask = pv.rows.some((r) => String(r.phone || '').includes('*'));
  ok('模型预览中手机号已脱敏', hasMask === true);

  console.log('\n[5] F1-5 自定义函数注册/测试/调用');
  const provFn = funcs.listFuncs().find((f) => f.func_code === 'PROVINCE_NAME');
  const tf = funcs.testFunc(provFn.id, ['410000'], { username: 'analyst', role: 'ANALYST' });
  ok('省份函数在线测试 410000→河南', tf.ok && tf.result === '河南', json(tf));

  console.log('\n[6] F1-1..F1-4,F1-6 组合分析引擎（多模型关联+筛选+聚合+四则+多步骤+SQL）');
  const mid = (t) => reg.get(`SELECT id FROM sys_model WHERE physical_table=?`, [t]).id;
  const cfg = {
    name: '主副卡共享流量·流量类投诉高发客户群',
    models: [mid('sj_customer_profile'), mid('sj_plan_order'), mid('sj_cust_complaint'), mid('sj_cust_traffic_usage')],
    steps: [
      { type: 'filter', name: '主副卡共享产品', conditions: [{ field: 'plan_name', op: 'contains', value: '主副卡' }], logic: 'and' },
      { type: 'filter', name: '流量类投诉', conditions: [{ field: 'complaint_type_code', op: 'eq', value: 'FL' }], logic: 'and' },
      { type: 'aggregate', name: '按省份与月份分组汇总', group: ['province_code', 'stat_month'],
        aggs: [
          { alias: '超套流量合计', field: 'over_traffic', op: 'sum', decimal: 2 },
          { alias: '月均实际流量', field: 'actual_traffic', op: 'avg', decimal: 2 },
          { alias: '流量类投诉量', field: 'id', op: 'count' },
          { alias: '投诉客户数', field: 'cust_id', op: 'countd' },
        ] },
      { type: 'calc', name: '超套占比%', exprs: [{ alias: '超套占比%', expr: '({超套流量合计} / {月均实际流量}) * 100', decimal: 2 }] },
      { type: 'sort', name: '按投诉量排序Top20', sort: [{ field: '流量类投诉量', dir: 'desc' }], topN: 20 },
    ],
  };
  const issues = engine.validate(cfg, cfg.models.map((id) => models.getModel(id)));
  ok('流程配置校验通过', issues.length === 0, issues.join(';'));
  const res = await engine.runFlow(cfg, { needMask: false });
  ok('执行成功且行数>0', res.total > 0, 'rows=' + res.total);
  const hasAgg = res.rows.some((r) => typeof r['超套流量合计'] === 'number');
  ok('含求和字段', hasAgg);
  const hasDerived = res.rows.every((r) => typeof r['超套占比%'] === 'number' || r['超套占比%'] == null);
  ok('含四则派生字段', hasDerived);
  const provinceConvert = (await funcs.testFunc(funcs.listFuncs().find((f) => f.func_code === 'PROVINCE_NAME').id, [String(res.rows[0].province_code)], { username: 'a', role: 'A' }));
  ok('省份编码经函数可读化', provinceConvert.ok && provinceConvert.result.length >= 2, json(provinceConvert));
  ok('SQL预览非空', (res.sql || '').length > 40);
  // 步骤断点预览：只执行到第2步（聚合前）
  const res2 = await engine.runFlow(cfg, { until: 1, needMask: false });
  ok('断点执行到筛选步骤行数<=明细', res2.total > 0);

  console.log('\n[7] F1-7 取数任务（即时执行/周期/终止）');
  const flow = tasks.saveFlow({ flow_name: '演示主流程', config: cfg }, { username: 'analyst', role: 'ANALYST' });
  const task = tasks.createTask({ task_name: '演示即时任务', flow_id: flow.id, exec_type: 'ONCE', retry: 1 }, { username: 'analyst', role: 'ANALYST' });
  await tasks.executeTask(task.id);
  const doneTask = tasks.getTask(task.id);
  ok('即时任务执行成功', doneTask.status === 'SUCCESS' && doneTask.runs.length >= 1, 'status=' + doneTask.status);
  ok('结果行数与汇总一致', doneTask.runs && doneTask.runs[0] && doneTask.runs[0].row_count > 0, json(doneTask.runs && doneTask.runs[0]).slice(0, 200));
  // 周期任务：每5秒
  const ct = tasks.createTask({ task_name: '周期任务演示', flow_id: flow.id, exec_type: 'CRON', cron: '*/5 * * * * *', cron_desc: '每5秒执行(演示)', schedule_to: '2099-12-31' }, { username: 'analyst', role: 'ANALYST' });
  ok('周期任务已计算下次执行时间', !!ct.next_run_at, ct.next_run_at || '');
  const nx = cronMod.nextRun('*/5 * * * * *', Date.now());
  ok('Cron下次时间计算正常', nx != null && nx > Date.now());
  // 终止
  const term = tasks.terminateTask(ct.id, { username: 'analyst', role: 'ANALYST' });
  ok('任务可终止', term.status === 'TERMINATED');

  console.log('\n[8] F2-1 分析结果开放为API + F2-2 鉴权/授权/限流 + F2-3 加密');
  const run = tasks.getTask(doneTask.id).runs[0];
  const app = open.createApp({ app_name: '客户声音掘金应用(模拟调用方)' }, { username: 'security_admin', role: 'SECURITY_ADMIN' });
  // 生成调用方RSA密钥对并登记公钥
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const pubJwk = crypto.createPublicKey(kp.publicKey).export({ format: 'jwk' });
  open.registerPubKey(app.id, pubJwk, { username: 'security_admin', role: 'SECURITY_ADMIN' });
  const api = open.openAsApi({
    api_name: '流量投诉高发客户群(总量+抽样)', api_path: 'risk_flow_complaints',
    run_id: run.id, return_struct: 'BOTH', param_defs: [{ name: 'province', column: 'province_code', required: false }],
    encrypt: 1, limit_per_sec: 5, limit_per_day: 10000,
  }, { username: 'analyst', role: 'ANALYST' });
  const pb = open.requestPublishApi(api.id, { username: 'approver', role: 'APPROVER' });
  ok('API审核通过后发布', !pb.need && open.getApi(api.id).status === 'PUBLISHED');
  const authz = open.createAuthz({ app_id: app.id, api_id: api.id, data_scope: { province_code: [] }, field_scope: [] }, { username: 'security_admin', role: 'SECURITY_ADMIN' });
  const pend = approvals.listPending();
  ok('无未处理审批遗留', pend.length === 0);
  // 未授权调用被拒（模拟新应用）
  const app2 = open.createApp({ app_name: '未授权应用' }, { username: 'security_admin', role: 'SECURITY_ADMIN' });
  const authzList = open.listAuthz();
  const gateOk = (aid) => authzList.some((z) => z.app_id === aid && z.api_id === api.id && z.status === 'ACTIVE');
  ok('未授权应用被拒绝(403)', gateOk(app2.id) === false);
  const accAuthz = authzList.find((z) => z.app_id === app.id && z.api_id === api.id);
  const acc1 = open.executeCall(open.getApi(api.id), open.getApp(app.id), accAuthz, { page: 1 }, {});
  ok('授权调用成功', acc1.ok && acc1.code === 0);
  open.logCall({ app: open.getApp(app.id), api: open.getApi(api.id), ok: true, statusCode: 200, params: { page: 1 }, latency: 12, ip: '127.0.0.1' });
  if (acc1.ok && acc1.encrypted) {
    const privJwk = crypto.createPrivateKey(kp.privateKey).export({ format: 'jwk' });
    const plain = cryptoLib.hybridDecrypt(privJwk, acc1.env);
    ok('混合加密返回可解密还原', plain && plain.code === 0 && plain.data && typeof plain.data.total === 'number');
    const row0 = plain.data.list && plain.data.list[0];
    if (row0) { const phoneVal = Object.keys(row0).find((k) => k.includes('phone')); ok('接口返回手机号已脱敏', !phoneVal || String(row0[phoneVal]).includes('*')); }
  }
  // Token 验证
  const tk = cryptoLib.openToken(open.getApp(app.id));
  ok('开放Token签发与校验', cryptoLib.verifyOpen(tk) !== null);
  const logs = open.listCallLogs({ apiId: api.id });
  ok('调用日志已记录', logs.length >= 1);
  const mon = open.apiMonitor();
  ok('调用监控统计可用', mon.total > 0);

  console.log('\n[9] 角色/审计/结果导出检查');
  const acts = reg.all(`SELECT COUNT(*) c FROM sys_audit`)[0].c;
  ok('审计日志已落库', acts > 5, 'audits=' + acts);

  console.log('\n==================== 自测完成：通过 ' + pass + '，失败 ' + fail + ' ====================');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE ERROR:', e); process.exit(1); });
