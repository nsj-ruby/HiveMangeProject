/**
 * 演示库一键初始化：注册 11 张模型（自动读取元数据并套用目录建议）→ 配置模型关系 → 装载内置函数。
 * 各步骤可重复调用（幂等：已存在则跳过/补漏），也可在界面单独完成 F3 全流程。
 */
'use strict';
const reg = require('../registry');
const seed = require('../seed');
const modelsSvc = require('./models');
const funcsSvc = require('./funcs');
const auth = require('../auth');
const { now } = require('../util');

const DEFAULT_RELATIONS = [
  // 经典场景关系：客户标识主键关联
  ['sj_customer_profile', 'sj_plan_order', ['cust_id'], ['cust_id'], 'INNER', '客户与套餐订购按客户标识1:N关联'],
  ['sj_customer_profile', 'sj_cust_complaint', ['cust_id'], ['cust_id'], 'INNER', '客户与投诉按客户标识关联'],
  ['sj_customer_profile', 'sj_cust_work_order', ['cust_id'], ['cust_id'], 'INNER', '客户与工单按客户标识关联'],
  ['sj_customer_profile', 'sj_cust_traffic_usage', ['cust_id'], ['cust_id'], 'INNER', '客户与流量使用按客户标识关联'],
  ['sj_customer_profile', 'sj_cust_voice_track', ['cust_id'], ['cust_id'], 'INNER', '客户与交互轨迹关联'],
  ['sj_customer_profile', 'sj_cust_survey', ['cust_id'], ['cust_id'], 'INNER', '客户与满意度回访关联'],
  ['sj_customer_profile', 'sj_cust_payment', ['cust_id'], ['cust_id'], 'INNER', '客户与账务信息关联'],
  ['sj_customer_profile', 'sj_marketing_contact', ['cust_id'], ['cust_id'], 'INNER', '客户与营销接触关联'],
  ['sj_customer_profile', 'sj_customer_tag', ['cust_id'], ['cust_id'], 'INNER', '客户与标签关联'],
  // 服务量可再关联（多字段）
  ['sj_cust_complaint', 'sj_service_volume', ['province_code'], ['province_code'], 'INNER', '投诉与服务量按省份关联（用于全省服务量基准对比，注意多对多）'],
];

async function provisionDemo() {
  const user = { username: 'model_admin', role: 'MODEL_ADMIN' };
  const summary = { models: [], relations: [], funcs: [] };
  funcsSvc.ensureBuiltins();
  summary.funcs.push('内置函数已装载');

  for (const t of seed.TABLES) {
    const exist = reg.get(`SELECT * FROM sys_model WHERE physical_table=?`, [t.table]);
    if (!exist) {
      const id = reg.insert('sys_model', {
        model_code: 'DM_' + t.table.toUpperCase(), model_name: t.cn, physical_table: t.table,
        topic: t.topic, biz_category: t.topic, cycle: t.cycle || 'T+1', biz_desc: t.desc,
        owner: 'model_admin', status: 'PUBLISHED', version: 1, data_count: 100,
        created_by: 'model_admin', created_at: now(), updated_at: now(),
      });
      for (const c of t.columns) {
        reg.insert('sys_field', {
          model_id: id, field_name: c.name, field_cn: c.cn, field_type: c.type,
          nullable: c.pk ? 0 : 1, is_pk: c.pk ? 1 : 0,
          is_sensitive: c.sens ? 1 : 0, sens_level: c.sens || '',
          mask_alg: (c.mask || '').toUpperCase(), mask_params: JSON.stringify(
            c.sens ? { keepLeft: c.name === 'cust_name' ? 1 : 3, keepRight: c.name === 'cust_name' ? 0 : 4, maskChar: '*' } : {}),
          role_exempt: '[]', dict: c.dict || '',
        });
      }
      summary.models.push(t.cn);
    }
  }
  // 模型注册后同步真实行数
  const biz = require('../biz');
  try {
    const bizDb = await biz.getBiz();
    for (const t of seed.TABLES) {
      const m = reg.get(`SELECT * FROM sys_model WHERE physical_table=?`, [t.table]);
      if (m) { const c = await bizDb.count(t.table); reg.run(`UPDATE sys_model SET data_count=?, status='PUBLISHED' WHERE id=?`, [c, m.id]); }
    }
  } catch (e) { /* 忽略 */ }

  // 模型关系
  for (const [lt, rt, lf, rf, typ, note] of DEFAULT_RELATIONS) {
    const L = reg.get(`SELECT id FROM sys_model WHERE physical_table=?`, [lt]);
    const R = reg.get(`SELECT id FROM sys_model WHERE physical_table=?`, [rt]);
    if (!L || !R) continue;
    const dup = reg.get(`SELECT id FROM sys_relation WHERE left_model_id=? AND right_model_id=? AND left_fields=? AND right_fields=?`,
      [L.id, R.id, JSON.stringify(lf), JSON.stringify(rf)]);
    if (!dup) {
      modelsSvc.createRelation({ left_model_id: L.id, left_fields: lf, right_model_id: R.id, right_fields: rf, rel_type: typ, biz_note: note, confidence: '高' }, user);
      summary.relations.push(`${lt}↔${rt}`);
    }
  }
  return summary;
}

module.exports = { provisionDemo };
