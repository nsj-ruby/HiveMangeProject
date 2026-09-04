/**
 * 应用注册表（内置 SQLite）：模型元数据、脱敏策略、模型关系、函数、取数流程/任务/结果、
 * 开放API、应用与凭证、授权、审批、审计日志、站内消息 等系统对象的持久化存储。
 * 与业务数据源解耦：业务数据在 biz.js 数据源中，系统对象存于本注册表。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sys_user(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, display_name TEXT, role TEXT,
  phone TEXT, enabled INTEGER DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS sys_model(
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_code TEXT UNIQUE, model_name TEXT, physical_table TEXT,
  topic TEXT, biz_category TEXT, cycle TEXT, biz_desc TEXT, owner TEXT, status TEXT DEFAULT 'DRAFT',
  version INTEGER DEFAULT 1, data_count INTEGER DEFAULT 0, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sys_field(
  id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER, field_name TEXT, field_cn TEXT,
  field_type TEXT, nullable INTEGER DEFAULT 1, is_pk INTEGER DEFAULT 0, biz_note TEXT,
  is_sensitive INTEGER DEFAULT 0, sens_level TEXT DEFAULT '', mask_alg TEXT DEFAULT '',
  mask_params TEXT DEFAULT '{}', role_exempt TEXT DEFAULT '[]', dict TEXT DEFAULT '', sample TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS sys_relation(
  id INTEGER PRIMARY KEY AUTOINCREMENT, rel_code TEXT, left_model_id INTEGER, left_fields TEXT,
  right_model_id INTEGER, right_fields TEXT, rel_type TEXT DEFAULT 'INNER', biz_note TEXT,
  confidence TEXT DEFAULT '高', status TEXT DEFAULT 'ENABLED', use_count INTEGER DEFAULT 0,
  created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sys_func(
  id INTEGER PRIMARY KEY AUTOINCREMENT, func_code TEXT UNIQUE, func_name TEXT, category TEXT,
  func_desc TEXT, impl_type TEXT DEFAULT 'code', return_type TEXT DEFAULT 'STRING',
  in_params TEXT DEFAULT '[]', body TEXT, sample TEXT DEFAULT '[]',
  status TEXT DEFAULT 'DRAFT', version INTEGER DEFAULT 1, creator TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sys_flow(
  id INTEGER PRIMARY KEY AUTOINCREMENT, flow_code TEXT, flow_name TEXT, config TEXT,
  status TEXT DEFAULT 'DRAFT', version INTEGER DEFAULT 1, owner TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sys_task(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_code TEXT, task_name TEXT, flow_id INTEGER,
  exec_type TEXT DEFAULT 'ONCE', cron TEXT DEFAULT '', cron_desc TEXT DEFAULT '',
  status TEXT DEFAULT 'PENDING', owner TEXT, retry INTEGER DEFAULT 0, retry_left INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1, schedule_from TEXT, schedule_to TEXT, next_run_at TEXT, last_run_at TEXT,
  row_count INTEGER DEFAULT 0, error TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sys_run(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, run_no INTEGER, status TEXT,
  started_at TEXT, finished_at TEXT, duration_ms INTEGER DEFAULT 0, result TEXT,
  row_count INTEGER DEFAULT 0, error TEXT, expire_at TEXT, cleared INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS sys_api(
  id INTEGER PRIMARY KEY AUTOINCREMENT, api_code TEXT, api_name TEXT, api_path TEXT UNIQUE,
  method TEXT DEFAULT 'GET', source_task_id INTEGER, source_run_id INTEGER, param_defs TEXT DEFAULT '[]',
  return_struct TEXT DEFAULT 'BOTH', sample_count INTEGER DEFAULT 50, page_size INTEGER DEFAULT 100,
  limit_per_sec INTEGER DEFAULT 10, limit_per_day INTEGER DEFAULT 10000,
  encrypt INTEGER DEFAULT 1, encrypt_version TEXT DEFAULT 'v1', encrypt_alg TEXT DEFAULT 'RSA-OAEP-256+AES-256-GCM',
  status TEXT DEFAULT 'DRAFT', version INTEGER DEFAULT 1, owner TEXT, api_desc TEXT,
  created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sys_app(
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_code TEXT, app_name TEXT, app_key TEXT UNIQUE,
  secret_hash TEXT, status TEXT DEFAULT 'ACTIVE', created_by TEXT, note TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS sys_app_pubkey(
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_id INTEGER, key_version TEXT, public_jwk TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sys_authorization(
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_id INTEGER, api_id INTEGER, data_scope TEXT DEFAULT '{}',
  field_scope TEXT DEFAULT '[]', status TEXT DEFAULT 'ACTIVE', approved_by TEXT, approved_at TEXT,
  note TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sys_approval(
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, ref_type TEXT, ref_id INTEGER, payload TEXT DEFAULT '{}',
  proposer TEXT, status TEXT DEFAULT 'PENDING', approver TEXT, reason TEXT, created_at TEXT, handled_at TEXT);
CREATE TABLE IF NOT EXISTS sys_audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT, role TEXT, action TEXT, object_type TEXT,
  object_id TEXT, detail TEXT, ip TEXT, result TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sys_call_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_id INTEGER, app_key TEXT, api_id INTEGER, api_path TEXT,
  success INTEGER DEFAULT 1, status_code INTEGER, params TEXT, latency_ms INTEGER DEFAULT 0,
  ip TEXT, error TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sys_msg(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, title TEXT, body TEXT, read INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE IF NOT EXISTS sys_meta(key TEXT PRIMARY KEY, value TEXT);
`;

const SEED_USERS = [
  ['sys_admin', '系统管理员', 'SYS_ADMIN', '13900000001'],
  ['model_admin', '王模型(模型管理员)', 'MODEL_ADMIN', '13900000002'],
  ['analyst', '张运营(运营分析人员)', 'ANALYST', '13900000003'],
  ['approver', '李审核(结果审核人员)', 'APPROVER', '13900000004'],
  ['security_admin', '赵安全(安全管理员)', 'SECURITY_ADMIN', '13900000005'],
];
const ROLE_LABEL = {
  ANALYST: '运营分析人员', MODEL_ADMIN: '模型管理员', APPROVER: '结果审核人员',
  SECURITY_ADMIN: '安全管理员', SYS_ADMIN: '系统管理员', API_CONSUMER: '应用对接方(API消费方)',
};

function openRegistry() {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(config.registryDb);
  db.exec(SCHEMA);
  migrate();
  // 默认用户
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM sys_user').get().c;
  if (!cnt) {
    const ins = db.prepare('INSERT INTO sys_user(username,display_name,role,phone,created_at) VALUES(?,?,?,?,?)');
    for (const u of SEED_USERS) ins.run(u[0], u[1], u[2], u[3], new Date().toISOString().slice(0, 19).replace('T', ' '));
  }
  return db;
}

/** 轻量迁移：为旧库补齐可能缺失的列 */
function migrate() {
  const adds = {
    sys_task: [['row_count', 'INTEGER DEFAULT 0']],
  };
  for (const [table, cols] of Object.entries(adds)) {
    try {
      const exist = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      for (const [name, ddl] of cols) if (!exist.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    } catch (e) { /* 表不存在则忽略 */ }
  }
}

// ---------- 通用访问 ----------
function all(sql, params = []) { return db.prepare(sql).all(...params); }
function get(sql, params = []) { return db.prepare(sql).get(...params); }
function run(sql, params = []) { return db.prepare(sql).run(...params); }
function exec(sql) { db.exec(sql); }
function insert(table, obj) {
  const keys = Object.keys(obj);
  const vals = keys.map((k) => (obj[k] !== null && typeof obj[k] === 'object' ? JSON.stringify(obj[k]) : obj[k]));
  const cols = keys.join(',');
  const ph = keys.map(() => '?').join(',');
  const r = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${ph})`).run(...vals);
  return Number(r.lastInsertRowid);
}
function updateById(table, id, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=?`).join(',');
  const vals = keys.map((k) => (obj[k] !== null && typeof obj[k] === 'object' ? JSON.stringify(obj[k]) : obj[k]));
  db.prepare(`UPDATE ${table} SET ${sets} WHERE id=?`).run(...vals, id);
}
function removeById(table, id) { run(`DELETE FROM ${table} WHERE id=?`, [id]); }
function listAll(table, where = '', params = []) {
  return all(`SELECT * FROM ${table} ${where}`, params);
}

module.exports = { openRegistry, all, get, run, exec, insert, updateById, removeById, listAll, ROLE_LABEL, db };
