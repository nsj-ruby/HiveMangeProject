/**
 * 初始化 MySQL 业务库：连接 config.js 中配置的 MySQL（单一数据源），
 * 自动创建 11 张 sj_* 业务表（如不存在）并灌入每张 100 行模拟数据。
 * 用法：node scripts/init-mysql.js   （也可由 server.js 首次启动自动完成）
 */
'use strict';
process.env.DEMO_DRIVER = 'mysql'; // 强制 MySQL，不使用内置 SQLite 兜底

(async () => {
  const config = require('../config');
  const { initBusiness, getStatus } = require('../lib/biz');
  const seed = require('../lib/seed');
  const inst = await initBusiness();
  const biz = inst.biz;
  const st = getStatus();
  console.log('业务数据源(MySQL):', biz.name);
  console.log('建表/灌数结果:', st.seeded.length ? st.seeded.join(', ') : '（表已存在且已有数据，跳过灌数）');
  let ok = 0;
  for (const t of seed.TABLES) {
    const c = await biz.count(t.table);
    console.log(`  ${t.table}  ${t.cn}  => ${c} 行`);
    if (c === 100) ok++;
  }
  console.log(`完成：11 张表中 ${ok} 张为 100 行。库名 nsjaccount（host ${config.business.mysql.host}:${config.business.mysql.port}）`);
  await biz.close();
})().catch((e) => {
  console.error('MySQL 初始化失败：', e && e.message ? e.message : e);
  process.exit(1);
});
