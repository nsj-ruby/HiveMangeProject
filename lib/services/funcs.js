/**
 * 服务：自定义数据处理函数（F1-5）注册 / 测试 / 发布 / 沙箱执行 / 影响分析。
 * 执行环境：node:vm 受限上下文 + 代码白名单校验（禁止文件/网络/进程等危险操作）。
 */
'use strict';
const vm = require('vm');
const reg = require('../registry');
const seed = require('../seed');
const auth = require('../auth');
const { now, json } = require('../util');

const FUNC_STATUS = ['DRAFT', 'PUBLISHED', 'OFF'];

const CODE_MAP = {
  PROVINCE: Object.fromEntries(seed.PROVINCES),
  BIZ: Object.fromEntries(seed.BIZS),
  ORDER_TYPE: Object.fromEntries(seed.ORDER_TYPES),
  COMPLAINT_TYPE: Object.fromEntries(seed.COMPLAINT_TYPES),
  TRACK_TYPE: Object.fromEntries(seed.TRACK_TYPES),
  CHANNEL: Object.fromEntries(seed.CHANNELS),
};

// 内置函数（首次启动自动装载，演示开箱即用）
const BUILTINS = [
  {
    func_code: 'PROVINCE_NAME', func_name: '省份编码转名称', category: '码表转换',
    func_desc: '将省份编码(如410000)转换为省份中文名，用于可读性提升', return_type: 'STRING',
    in_params: [{ name: 'code', type: 'STRING', required: true, note: '省份编码' }],
    body: `const m = CODE_MAP.PROVINCE;\nreturn m[String(code)] || ('未知:' + code);`,
  },
  {
    func_code: 'BIZ_NAME', func_name: '业务类型编码转名称', category: '码表转换',
    func_desc: '业务类型编码(SHFL/LZ/5G等)转业务中文名', return_type: 'STRING',
    in_params: [{ name: 'code', type: 'STRING', required: true, note: '业务类型编码' }],
    body: `const m = CODE_MAP.BIZ;\nreturn m[String(code)] || ('未知:' + code);`,
  },
  {
    func_code: 'ORDER_TYPE_NAME', func_name: '工单类型编码转名称', category: '码表转换',
    func_desc: '工单类型编码转中文名', return_type: 'STRING',
    in_params: [{ name: 'code', type: 'STRING', required: true, note: '工单类型编码' }],
    body: `const m = CODE_MAP.ORDER_TYPE;\nreturn m[String(code)] || ('未知:' + code);`,
  },
  {
    func_code: 'COMPLAINT_TYPE_NAME', func_name: '投诉类型编码转名称', category: '码表转换',
    func_desc: '投诉类型编码(FL流量类等)转中文名', return_type: 'STRING',
    in_params: [{ name: 'code', type: 'STRING', required: true, note: '投诉类型编码' }],
    body: `const m = CODE_MAP.COMPLAINT_TYPE;\nreturn m[String(code)] || ('未知:' + code);`,
  },
  {
    func_code: 'CHANNEL_NAME', func_name: '渠道编码转名称', category: '码表转换',
    func_desc: '渠道编码转渠道中文名', return_type: 'STRING',
    in_params: [{ name: 'code', type: 'STRING', required: true, note: '渠道编码' }],
    body: `const m = CODE_MAP.CHANNEL;\nreturn m[String(code)] || String(code);`,
  },
  {
    func_code: 'ORDER_STATUS_NAME', func_name: '工单状态编码转名称', category: '码表转换',
    func_desc: '工单状态编码转状态中文名', return_type: 'STRING',
    in_params: [{ name: 'code', type: 'STRING', required: true, note: '状态编码' }],
    body: `const m = {OPEN:'处理中',DONE:'已办结',CLOSE:'已关闭',ACTIVE:'生效',STOP:'停机',CHURN:'离网'};\nreturn m[String(code)] || String(code);`,
  },
  {
    func_code: 'QUARTER', func_name: '月份转季度', category: '日期加工',
    func_desc: '统计月份(YYYY-MM)转换为季度(Q1-Q4)', return_type: 'STRING',
    in_params: [{ name: 'month', type: 'STRING', required: true, note: '如 2026-06' }],
    body: `const m = String(month); const mm = m.slice(5,7);\nreturn m.slice(0,4) + '-Q' + Math.ceil(Number(mm)/3);`,
  },
  {
    func_code: 'PHONE_PROVINCE', func_name: '手机号码归属识别', category: '号码识别',
    func_desc: '按手机号码前3位/号段识别归属省份（示例规则）', return_type: 'STRING',
    in_params: [{ name: 'phone', type: 'STRING', required: true, note: '手机号码' }],
    body: `const p = String(phone);\nconst prefix = p.slice(0,3);\nconst m = {'138':'河南','139':'河南','150':'河南','188':'广东','186':'广东','135':'广东','137':'北京','158':'江苏','159':'江苏','131':'浙江','130':'山东','151':'四川','182':'四川','133':'湖北','187':'湖北','189':'福建','134':'北京','152':'湖南','153':'广西','155':'陕西','156':'新疆','157':'天津','185':'上海','147':'上海','176':'重庆','177':'辽宁'};\nreturn m[prefix] || '其他';`,
  },
  {
    func_code: 'AGE_GROUP', func_name: '年龄分段', category: '客户画像',
    func_desc: '客户年龄按 青年/中年/老年 分段', return_type: 'STRING',
    in_params: [{ name: 'age', type: 'NUMBER', required: true, note: '年龄' }],
    body: `const a = Number(age);\nif (a < 25) return '青年'; if (a < 40) return '中青年'; if (a < 60) return '中年'; return '老年';`,
  },
  {
    func_code: 'STAR_DESC', func_name: '星级档位描述', category: '客户画像',
    func_desc: '客户星级转换为档位描述', return_type: 'STRING',
    in_params: [{ name: 'star', type: 'STRING', required: true, note: '星级1-7' }],
    body: `const s = Number(star);\nif (s >= 6) return '高星级客户'; if (s >= 4) return '中高星级客户'; if (s >= 2) return '中星级客户'; return '低星级客户';`,
  },
];

const DANGER = /require\s*\(|\bimport\b|\bprocess\b|\bglobalThis\b|\beval\s*\(|\bFunction\s*\(|\bchild_process\b|\bfs\b|http:|https:|fetch\s*\(|exec\s*\(|spawn\s*\(|rm\s*\(|unlink\s*\(|destroy\s*\(/;

function ensureBuiltins() {
  for (const b of BUILTINS) {
    const ex = reg.get(`SELECT id FROM sys_func WHERE func_code=?`, [b.func_code]);
    if (!ex) {
      reg.insert('sys_func', { ...b, sample: json([]), status: 'PUBLISHED', creator: 'system', created_at: now(), updated_at: now() });
    }
  }
}

function buildCtx(f, args) {
  const ctx = { Math, Number, String, Boolean, parseInt, parseFloat, Array, Object, Date, JSON, CODE_MAP: Object.fromEntries(Object.entries(CODE_MAP).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])), console: undefined };
  const params = JSON.parse(f.in_params || '[]');
  params.forEach((p, i) => { ctx[p.name] = args[i] !== undefined ? args[i] : null; });
  return ctx;
}

/** 沙箱执行函数 body（args 按入参顺序传入） */
function runFunc(f, args) {
  if (DANGER.test(f.body)) throw new Error('函数实现包含危险操作，已拒绝执行');
  const sandbox = buildCtx(f, args);
  vm.createContext(sandbox, { name: 'sj-func-sandbox', codeGeneration: { strings: false, wasm: false } });
  const start = Date.now();
  const result = vm.runInContext('(function(){ ' + f.body + '\n})()', sandbox, { timeout: 800 });
  return { result, ms: Date.now() - start };
}

function listFuncs() { return reg.all(`SELECT * FROM sys_func ORDER BY id`); }
function getFunc(id) { return reg.get(`SELECT * FROM sys_func WHERE id=?`, [id]); }
function getFuncByCode(code) { return reg.get(`SELECT * FROM sys_func WHERE func_code=?`, [code]); }

function createFunc(payload, user) {
  if (DANGER.test(payload.body || '')) throw new Error('函数实现包含危险操作，请检查后重试');
  const id = reg.insert('sys_func', {
    func_code: payload.func_code, func_name: payload.func_name, category: payload.category || '',
    func_desc: payload.func_desc || '', impl_type: payload.impl_type || 'code',
    return_type: payload.return_type || 'STRING', in_params: json(payload.in_params || []),
    body: payload.body || '', sample: json(payload.sample || []), status: 'DRAFT', version: 1,
    creator: user.username, created_at: now(), updated_at: now(),
  });
  auth.audit(user.username, user.role, '函数注册', 'func', id, payload.func_code);
  return { id };
}

function updateFunc(id, patch, user) {
  if (patch.body && DANGER.test(patch.body)) throw new Error('函数实现包含危险操作');
  reg.updateById('sys_func', id, { ...patch, updated_at: now() });
  auth.audit(user.username, user.role, '函数修改', 'func', id, json(patch));
  return getFunc(id);
}
function setFuncStatus(id, status, user) {
  reg.run(`UPDATE sys_func SET status=?, updated_at=? WHERE id=?`, [status, now(), id]);
  auth.audit(user.username, user.role, status === 'PUBLISHED' ? '函数发布' : '函数上下架', 'func', id, status);
  return getFunc(id);
}
function removeFunc(id, user) {
  const f = getFunc(id);
  reg.run(`DELETE FROM sys_func WHERE id=?`, [id]);
  auth.audit(user.username, user.role, '函数删除', 'func', id, f && f.func_code);
}

/** 在线测试 */
function testFunc(id, args, user) {
  const f = getFunc(id);
  try {
    const r = runFunc(f, args || []);
    auth.audit(user.username, user.role, '函数在线测试', 'func', id, f.func_code + ' 耗时' + r.ms + 'ms');
    return { ok: true, result: r.result, ms: r.ms };
  } catch (e) {
    auth.audit(user.username, user.role, '函数在线测试', 'func', id, f.func_code + ' 失败', '', 'FAIL');
    return { ok: false, error: String(e.message || e), ms: 0 };
  }
}

/** 影响分析：函数被哪些取数流程/开放API引用 */
function usage(id) {
  const f = getFunc(id);
  const key = f.func_code;
  const flows = reg.all(`SELECT id, flow_code, flow_name, status FROM sys_flow WHERE config LIKE ?`, [`%${key}%`]);
  const apis = reg.all(`SELECT * FROM sys_api WHERE 1=0`); // API 引用流程，函数影响经由流程体现
  return { func: f, flows };
}

/** 函数作为“字段转换”步骤执行入口（供引擎使用） */
function callByCode(code, args) {
  const f = getFuncByCode(code);
  if (!f || f.status !== 'PUBLISHED') throw new Error(`函数 ${code} 不存在或未发布`);
  return runFunc(f, args).result;
}

module.exports = { ensureBuiltins, BUILTINS, listFuncs, getFunc, getFuncByCode, createFunc, updateFunc, setFuncStatus, removeFunc, testFunc, usage, callByCode, runFunc, FUNC_STATUS };
