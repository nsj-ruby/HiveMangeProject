/**
 * 业务数据源适配层（单一数据源）。
 *  - sqlite：内置演示库（零依赖，node:sqlite）
 *  - mysql ：采购方指定的 MySQL（需 npm install mysql2，连接参数见 config.js）
 * 两种模式共用同一套 DDL 与 100 行/表 模拟数据，对外暴露统一的异步查询接口。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { buildDDL, buildRows, TABLES } = require('./seed');
const { q, now } = require('./util');

let instance = null;

class SqliteBiz {
  constructor(file) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.kind = 'sqlite';
    this.name = '内置演示库(SQLite)';
    this.detail = { file, driver: 'sqlite' };
  }
  async exec(sql, params = []) { this.db.prepare(sql).run(...params); }
  async query(sql, params = []) { return this.db.prepare(sql).all(...params); }
  async initSchema() {
    for (const ddl of buildDDL()) this.db.exec(ddl);
  }
  async seedIfEmpty() {
    const { rows } = buildRows();
    const out = [];
    for (const t of TABLES) {
      const r = this.db.prepare(`SELECT COUNT(*) AS c FROM ${q(t.table)}`).get();
      if (!r || r.c === 0) {
        const cols = t.columns.map((c) => c.name);
        const ph = cols.map(() => '?').join(',');
        const ins = this.db.prepare(`INSERT INTO ${q(t.table)} (${cols.map(q).join(',')}) VALUES (${ph})`);
        for (const row of rows[t.table]) ins.run(...cols.map((c) => row[c]));
        out.push(`${t.table}:${rows[t.table].length}`);
      }
    }
    return out;
  }
  async listTables() {
    return this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE ? ORDER BY name`).all(`${config.tablePrefix}%`)
      .map((r) => r.name);
  }
  async fetchColumns(table) {
    const info = this.db.prepare(`PRAGMA table_info(${q(table)})`).all();
    return info.map((c) => ({
      name: c.name, type: c.type || 'TEXT', nullable: !c.notnull,
      pk: c.pk > 0, comment: '', dflt: c.dflt_value,
    }));
  }
  async count(table) { const r = this.db.prepare(`SELECT COUNT(*) AS c FROM ${q(table)}`).get(); return r ? r.c : 0; }
  async sample(table, n = 100, cols = null) {
    const colSql = cols && cols.length ? cols.map(q).join(',') : '*';
    return this.db.prepare(`SELECT ${colSql} FROM ${q(table)} LIMIT ${n}`).all();
  }
  async close() { try { this.db.close(); } catch (e) {} }
}

class MysqlBiz {
  constructor(m) {
    this.m = m; this.kind = 'mysql';
    this.name = '远程MySQL(' + m.host + ':' + m.port + '/' + m.database + ')';
    this.detail = { host: m.host, port: m.port, database: m.database, user: m.user, driver: 'mysql' };
  }
  async connect() {
    const mysql = require('mysql2/promise'); // 依赖可选：npm install mysql2
    this.pool = mysql.createPool({ ...this.m, charset: 'utf8mb4', waitForConnections: true, connectionLimit: 5, decimalNumbers: false });
    await this.pool.query('SELECT 1'); // 连通性探测
  }
  async exec(sql, params = []) { await this.pool.query(sql, params); }
  async query(sql, params = []) { const [r] = await this.pool.query(sql, params); return r; }
  async initSchema() { for (const ddl of buildDDL()) await this.pool.query(ddl); }
  async seedIfEmpty() {
    const { rows } = buildRows();
    const out = [];
    for (const t of TABLES) {
      const [r] = await this.pool.query(`SELECT COUNT(*) AS c FROM ${q(t.table)}`);
      if (!r[0].c) {
        const cols = t.columns.map((c) => c.name);
        const ph = cols.map(() => '?').join(',');
        const sql = `INSERT INTO ${q(t.table)} (${cols.map(q).join(',')}) VALUES (${ph})`;
        for (const row of rows[t.table]) await this.pool.query(sql, cols.map((c) => row[c]));
        out.push(`${t.table}:${rows[t.table].length}`);
      }
    }
    return out;
  }
  async listTables() {
    const [r] = await this.pool.query(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE ? ORDER BY table_name`,
      [this.m.database, config.tablePrefix + '%']);
    return r.map((x) => x.name);
  }
  async fetchColumns(table) {
    const [r] = await this.pool.query(
      `SELECT column_name AS name, column_type AS type, is_nullable AS nullable, column_key AS ck, column_comment AS comment
         FROM information_schema.columns WHERE table_schema=? AND table_name=? ORDER BY ordinal_position`,
      [this.m.database, table]);
    return r.map((c) => ({
      name: c.name, type: c.type, nullable: c.nullable === 'YES',
      pk: c.ck === 'PRI', comment: c.comment || '',
    }));
  }
  async count(table) { const r = await this.query(`SELECT COUNT(*) AS c FROM ${q(table)}`); return r[0].c; }
  async sample(table, n = 100, cols = null) {
    const colSql = cols && cols.length ? cols.map(q).join(',') : '*';
    return this.query(`SELECT ${colSql} FROM ${q(table)} LIMIT ${n}`);
  }
  async close() { try { await this.pool.end(); } catch (e) {} }
}

/**
 * 初始化业务数据源：探测可用驱动 → 建表 → 若空表则灌入 100 行模拟数据。
 * @returns {{biz: object, status: object}}
 */
async function initBusiness() {
  if (instance) return instance;
  const cfg = config.business;
  const status = { mode: cfg.driver, actual: '', message: '', tables: [], seeded: [] };
  const useMysql = (cfg.driver === 'mysql') || (cfg.driver === 'auto');
  if (useMysql) {
    let m = null;
    try {
      const mb = new MysqlBiz(cfg.mysql);
      await mb.connect();
      m = mb;
    } catch (e) {
      if (cfg.driver === 'mysql') {
        throw new Error('MySQL 连接失败，请检查连接参数或执行 npm install mysql2。原因：' + e.message);
      }
      status.message = '未检测到 mysql2 驱动或远程 MySQL 不可达，已自动切换内置 SQLite 演示库（' + e.message + '）';
    }
    if (m) {
      status.actual = 'mysql';
      try {
        await m.initSchema();
        status.seeded = await m.seedIfEmpty();
        instance = { biz: m, status };
        return instance;
      } catch (e) {
        // 连接成功但建表/初始化失败（如库权限受限）
        await m.close().catch(() => {});
        if (cfg.driver === 'mysql') throw e;
        status.message = 'MySQL 连接成功但建表/初始化失败，已自动切换内置 SQLite 演示库（' + e.message + '）';
      }
    }
  }
  const sb = new SqliteBiz(cfg.sqliteFile);
  await sb.initSchema();
  status.actual = 'sqlite';
  status.message = status.message || '使用内置 SQLite 演示业务库（离线可用，数据与 MySQL 模式一致）';
  status.seeded = await sb.seedIfEmpty();
  instance = { biz: sb, status };
  return instance;
}

async function getBiz() {
  if (!instance) await initBusiness();
  return instance.biz;
}
function getStatus() { return instance ? instance.status : null; }

module.exports = { initBusiness, getBiz, getStatus };
