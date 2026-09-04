/**
 * 服务：分析模型管理（M3）— F3-1 模型注册/元数据自动读取、F3-2 字段脱敏配置、F3-3 模型数据预览、F3-4 模型间关系配置。
 */
'use strict';
const reg = require('../registry');
const bizMod = require('../biz');
const seed = require('../seed');
const desen = require('../desensitize');
const auth = require('../auth');
const { now, q, parse, json, round } = require('../util');

const MODEL_STATUS = ['DRAFT', 'PUBLISHED', 'STOPPED', 'OFFLINE'];
const REL_STATUS = ['ENABLED', 'DISABLED'];

// ---------------- 元数据读取（F3-1） ----------------
async function metaReadTable(table) {
  const biz = await bizMod.getBiz();
  const catalog = seed.getTableDef(table);
  const cols = await biz.fetchColumns(table);
  const count = await biz.count(table);
  return {
    physicalTable: table,
    catalog: catalog ? { cn: catalog.cn, topic: catalog.topic, cycle: catalog.cycle, desc: catalog.desc } : null,
    dataCount: count,
    fields: cols.map((c) => {
      const cc = catalog ? catalog.columns.find((x) => x.name === c.name) : null;
      const g = cc && cc.sens ? { sens: true, level: cc.sens, alg: cc.mask || 'MASK' } : desen.guessSensitiveByMeta(c.name, cc && cc.cn);
      return {
        field_name: c.name, field_type: c.type, nullable: c.nullable, is_pk: c.pk,
        field_cn: (cc && cc.cn) || guessCn(c.name),
        dict: (cc && cc.dict) || '',
        is_sensitive: g.sens, sens_level: g.level,
        mask_alg: cc && cc.mask ? cc.mask.toUpperCase() : (g.alg || ''),
        mask_params: algParams(g.alg || ''),
      };
    }),
  };
}

function guessCn(name) {
  const dict = {
    id: '主键', cust_id: '客户标识', phone: '手机号码', cust_name: '客户姓名', id_card: '证件号码',
    gender: '性别', age: '年龄', province_code: '省份编码', city: '地市', star_level: '星级',
    net_date: '入网日期', cust_status: '客户状态', order_no: '单号', complaint_no: '投诉编号',
    bill_no: '账务编号', contact_no: '接触编号', survey_no: '回访编号', order_type_code: '类型编码',
    biz_code: '业务编码', stat_month: '统计月份', count: '数量', amount: '金额', fee: '费用', time: '时间',
    date: '日期', status: '状态', code: '编码', name: '名称', flag: '标志', result: '结果', note: '备注',
  };
  const snake = String(name).toLowerCase().replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const parts = snake.split('_').filter(Boolean);
  return parts.map((p) => dict[p] || p).join('_');
}

function algParams(alg) {
  const d = { MASK: { keepLeft: 3, keepRight: 4, maskChar: '*' }, TRUNC: { keep: 4 }, BUCKET: { bucketSize: 10 } };
  return json(d[alg] || {});
}

// ---------------- 模型注册管理 ----------------
function registerModel(payload, user) {
  const code = 'DM_' + (payload.physicalTable || '').toUpperCase();
  const id = reg.insert('sys_model', {
    model_code: code, model_name: payload.model_name || payload.physicalTable,
    physical_table: payload.physicalTable, topic: payload.topic || '', biz_category: payload.biz_category || '',
    cycle: payload.cycle || 'T+1', biz_desc: payload.biz_desc || '', owner: payload.owner || user.username,
    status: 'DRAFT', version: 1, data_count: payload.dataCount || 0, created_by: user.username,
    created_at: now(), updated_at: now(),
  });
  for (const f of payload.fields || []) {
    reg.insert('sys_field', {
      model_id: id, field_name: f.field_name, field_cn: f.field_cn || f.field_name, field_type: f.field_type || '',
      nullable: f.nullable ? 1 : 0, is_pk: f.is_pk ? 1 : 0, biz_note: f.biz_note || '',
      is_sensitive: f.is_sensitive ? 1 : 0, sens_level: f.sens_level || '', mask_alg: f.mask_alg || '',
      mask_params: json(f.mask_params || {}), role_exempt: json(f.role_exempt || []), dict: f.dict || '',
    });
  }
  auth.audit(user.username, user.role, '模型注册', 'model', id, `注册模型 ${payload.model_name}(${payload.physicalTable})`, '', 'OK');
  return { id };
}

function listModels() {
  return reg.all(`SELECT m.*, (SELECT COUNT(*) FROM sys_field f WHERE f.model_id=m.id) AS fieldsCount FROM sys_model m ORDER BY m.id`);
}

function listModelCodes() {
  return reg.all(`SELECT id, model_code, model_name, physical_table, status FROM sys_model ORDER BY model_name`);
}

function getModel(id) {
  const m = reg.get(`SELECT * FROM sys_model WHERE id=?`, [id]);
  if (!m) return null;
  m.fields = reg.all(`SELECT * FROM sys_field WHERE model_id=? ORDER BY id`, [id]);
  return m;
}

function setModelStatus(id, status, user) {
  reg.run(`UPDATE sys_model SET status=?, updated_at=? WHERE id=?`, [status, now(), id]);
  auth.audit(user.username, user.role, '模型状态变更', 'model', id, `状态变更为 ${status}`);
  return getModel(id);
}

function updateModel(id, patch, user) {
  reg.updateById('sys_model', id, { ...patch, updated_at: now() });
  auth.audit(user.username, user.role, '模型信息修改', 'model', id, json(patch));
  return getModel(id);
}

/** 元数据再同步：读取物理表结构并与已注册字段比对差异 */
async function syncModelMeta(id, user) {
  const m = getModel(id);
  const biz = await bizMod.getBiz();
  const live = await metaReadTable(m.physical_table);
  const old = m.fields;
  const added = [], changed = [], removed = [];
  for (const lf of live.fields) {
    const o = old.find((f) => f.field_name === lf.field_name);
    if (!o) {
      added.push(lf.field_name);
      const g = lf.is_sensitive ? 1 : 0;
      reg.insert('sys_field', {
        model_id: id, field_name: lf.field_name, field_cn: lf.field_cn, field_type: lf.field_type,
        nullable: lf.nullable ? 1 : 0, is_pk: lf.is_pk ? 1 : 0, is_sensitive: g,
        sens_level: lf.sens_level, mask_alg: lf.mask_alg, mask_params: json(lf.mask_params || {}), dict: lf.dict || '',
      });
    } else if (o.field_type !== lf.field_type || (o.is_pk ? 1 : 0) !== (lf.is_pk ? 1 : 0)) {
      changed.push(lf.field_name + '[' + o.field_type + '→' + lf.field_type + ']');
      reg.run(`UPDATE sys_field SET field_type=?, is_pk=?, nullable=? WHERE id=?`, [lf.field_type, lf.is_pk ? 1 : 0, lf.nullable ? 1 : 0, o.id]);
    }
  }
  for (const o of old) if (!live.fields.find((f) => f.field_name === o.field_name)) removed.push(o.field_name);
  reg.run(`UPDATE sys_model SET data_count=?, updated_at=? WHERE id=?`, [live.dataCount, now(), id]);
  auth.audit(user.username, user.role, '元数据同步', 'model', id, `新增:${added.join(',')} 变更:${changed.join(',')} 删除:${removed.join(',')}`);
  return { added, changed, removed, dataCount: live.dataCount };
}

// ---------------- 字段脱敏配置（F3-2） ----------------
function updateField(id, patch, user) {
  const allowed = ['field_cn', 'biz_note', 'is_sensitive', 'sens_level', 'mask_alg', 'mask_params', 'role_exempt', 'dict', 'nullable'];
  const upd = {};
  for (const k of allowed) if (k in patch) {
    upd[k] = typeof patch[k] === 'object' && patch[k] !== null ? json(patch[k]) : patch[k];
  }
  reg.updateById('sys_field', id, upd);
  const f = reg.get(`SELECT * FROM sys_field WHERE id=?`, [id]);
  auth.audit(user.username, user.role, '脱敏策略配置', 'field', id, `${f.field_name}:${f.mask_alg} ${f.mask_params}`);
  return f;
}

// ---------------- 模型数据预览（F3-3） ----------------
async function previewModel(id, opts, user) {
  const m = getModel(id);
  const biz = await bizMod.getBiz();
  const n = Math.min(opts.n || 100, 1000);
  const rows = await biz.sample(m.physical_table, n);
  const fields = m.fields;
  const maskedRows = rows.map((r) => {
    const o = {};
    for (const f of fields) {
      let v = r[f.field_name];
      if (Object.prototype.hasOwnProperty.call(r, f.field_name)) {
        const fm = { is_sensitive: f.is_sensitive, is_pk: f.is_pk, mask_alg: f.mask_alg, mask_params: f.mask_params, role_exempt: f.role_exempt, field_name: f.field_name };
        v = desen.apply(fm, v, user.role);
      }
      o[f.field_name] = v;
    }
    return o;
  });
  // 概要统计：取值分布（对有限枚举/短文本列）
  const total = m.data_count || (await biz.count(m.physical_table));
  const overview = { total, fieldCount: fields.length, rows: maskedRows.length };
  // 时间范围粗估
  let dist = null;
  const dictCols = fields.filter((f) => f.dict);
  if (dictCols.length && rows.length) {
    dist = {};
    for (const f of dictCols) {
      const cnt = {};
      for (const r of rows) { const v = String(r[f.field_name]); cnt[v] = (cnt[v] || 0) + 1; }
      dist[f.field_name] = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 12);
    }
  }
  return { model: m, fields: fields.map((f) => ({ ...f, is_sensitive: !!f.is_sensitive, is_pk: !!f.is_pk, nullable: !!f.nullable })), rows: maskedRows, overview, distribution: dist, sql: `SELECT * FROM ${q(m.physical_table)} LIMIT ${n} /* 脱敏在输出层执行 */` };
}

/** 单字段脱敏效果预览（配置页“所见即所得”） */
async function maskSample(modelId, fieldId, opts) {
  const f = reg.get(`SELECT * FROM sys_field WHERE id=? AND model_id=?`, [fieldId, modelId]);
  const m = reg.get(`SELECT * FROM sys_model WHERE id=?`, [modelId]);
  const biz = await bizMod.getBiz();
  const rawRows = await biz.sample(m.physical_table, 200, [f.field_name]);
  const seen = new Set(); const samples = [];
  for (const r of rawRows) {
    const v = r[f.field_name];
    if (v == null || seen.has(String(v))) continue;
    seen.add(String(v));
    samples.push(v);
    if (samples.length >= 10) break;
  }
  const fm = { is_sensitive: f.is_sensitive, mask_alg: f.mask_alg, mask_params: f.mask_params, role_exempt: f.role_exempt, field_name: f.field_name };
  return { field: f, raw: samples, masked: samples.map((v) => desen.apply(fm, v, opts.role || 'ANALYST')) };
}

// ---------------- 模型关系配置（F3-4） ----------------
function createRelation(payload, user) {
  const id = reg.insert('sys_relation', {
    rel_code: 'REL_' + seed.pad4(Date.now() % 10000) + Math.floor(Math.random() * 90 + 10),
    left_model_id: payload.left_model_id, left_fields: json(payload.left_fields),
    right_model_id: payload.right_model_id, right_fields: json(payload.right_fields),
    rel_type: payload.rel_type || 'INNER', biz_note: payload.biz_note || '', confidence: payload.confidence || '高',
    status: 'ENABLED', use_count: 0, created_by: user.username, created_at: now(), updated_at: now(),
  });
  auth.audit(user.username, user.role, '模型关系新建', 'relation', id, json(payload));
  return { id };
}

function listRelations() {
  return reg.all(`SELECT r.*, lm.model_name AS left_model_name, lm.physical_table AS left_table,
    rm.model_name AS right_model_name, rm.physical_table AS right_table
    FROM sys_relation r LEFT JOIN sys_model lm ON lm.id=r.left_model_id
    LEFT JOIN sys_model rm ON rm.id=r.right_model_id ORDER BY r.id`);
}

function getRelation(id) {
  return reg.get(`SELECT r.*, lm.model_name AS left_model_name, rm.model_name AS right_model_name FROM sys_relation r
    LEFT JOIN sys_model lm ON lm.id=r.left_model_id LEFT JOIN sys_model rm ON rm.id=r.right_model_id WHERE r.id=?`, [id]);
}

function setRelationStatus(id, status, user) {
  reg.run(`UPDATE sys_relation SET status=?, updated_at=? WHERE id=?`, [status, now(), id]);
  auth.audit(user.username, user.role, '模型关系状态变更', 'relation', id, status);
  return getRelation(id);
}

function removeRelation(id, user) {
  reg.run(`DELETE FROM sys_relation WHERE id=?`, [id]);
  auth.audit(user.username, user.role, '模型关系删除', 'relation', id, '');
}

/** 关系校验：字段类型一致性 + 抽样关联结果合理性（空关联 / 行膨胀） */
async function validateRelation(rel) {
  const L = reg.get(`SELECT * FROM sys_model WHERE id=?`, [rel.left_model_id]);
  const R = reg.get(`SELECT * FROM sys_model WHERE id=?`, [rel.right_model_id]);
  if (!L || !R) return { ok: false, message: '模型不存在' };
  const biz = await bizMod.getBiz();
  const lCols = await biz.fetchColumns(L.physical_table);
  const rCols = await biz.fetchColumns(R.physical_table);
  const lf = rel.left_fields, rf = rel.right_fields;
  const issues = [];
  for (let i = 0; i < lf.length; i++) {
    const a = lCols.find((c) => c.name === lf[i]);
    const b = rCols.find((c) => c.name === rf[i]);
    if (!a) issues.push(`左侧模型缺少字段 ${lf[i]}`);
    if (!b) issues.push(`右侧模型缺少字段 ${rf[i]}`);
    if (a && b) {
      const t1 = String(a.type).split('(')[0].toUpperCase();
      const t2 = String(b.type).split('(')[0].toUpperCase();
      if (t1 !== t2 && !(t1.includes('INT') && t2.includes('INT')) && !(t1.includes('CHAR') && t2.includes('CHAR')) && !(t1.includes('VARCHAR') && t2.includes('VARCHAR'))) {
        issues.push(`关联字段类型不一致：${lf[i]}(${a.type}) ↔ ${rf[i]}(${b.type})`);
      }
    }
  }
  if (!lf.length || !rf.length) issues.push('关联字段不能为空');
  // 抽样关联验证
  const Lrows = await biz.sample(L.physical_table, 300, lf);
  const Rrows = await biz.sample(R.physical_table, 300, rf);
  const keys = new Set();
  let joined = 0;
  for (const r of Lrows) {
    const k = lf.map((x) => String(r[x])).join('\u0001');
    keys.add(k);
    for (const s of Rrows) {
      let hit = true;
      for (let i = 0; i < lf.length; i++) if (String(s[rf[i]]) !== String(r[lf[i]])) { hit = false; break; }
      if (hit) joined++;
    }
  }
  const leftCnt = Lrows.length, rightCnt = Rrows.length;
  let warn = null;
  if (keys.size && !joined) warn = '抽样结果为0行：两表当前数据在关联字段上无匹配，请检查关联字段或数据。';
  else if (joined > Math.max(leftCnt, rightCnt) * 3) warn = `抽样关联行数(${joined})远大于两侧行数，存在一对多行数膨胀风险，建议在聚合/去重场景中使用该关系。`;
  return { ok: issues.length === 0, issues, sample: { left: leftCnt, right: rightCnt, joined }, warn };
}

/** 供组合分析自动推荐的可用关系 */
function recommendFor(modelIds) {
  const rels = listRelations().filter((r) => r.status === 'ENABLED' && modelIds.includes(r.left_model_id) && modelIds.includes(r.right_model_id));
  return rels;
}

function relationGraph() {
  const models = reg.all(`SELECT id, model_name, physical_table, topic FROM sys_model`);
  const rels = listRelations().filter((r) => r.status === 'ENABLED');
  return { nodes: models.map((m) => ({ id: m.id, label: m.model_name, topic: m.topic })), edges: rels.map((r) => ({ from: r.left_model_id, to: r.right_model_id, label: (r.left_fields || '').length < 60 ? r.left_fields + '↔' + r.right_fields : '关联', type: r.rel_type, id: r.id, useCount: r.use_count })) };
}

module.exports = {
  metaReadTable, registerModel, listModels, listModelCodes, getModel, setModelStatus, updateModel,
  syncModelMeta, updateField, previewModel, maskSample,
  createRelation, listRelations, getRelation, setRelationStatus, removeRelation, validateRelation,
  recommendFor, relationGraph, MODEL_STATUS, REL_STATUS,
};
