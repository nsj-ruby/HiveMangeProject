/**
 * 系统配置
 * 说明：业务数据源采用“单一数据源”设计。
 *   - driver=mysql  ：连接采购方指定的远程 MySQL（需执行 npm install mysql2）
 *   - driver=sqlite ：内置演示数据源（零依赖、离线可用，表结构与模拟数据与 MySQL 模式完全一致）
 *   - driver=auto   ：优先 MySQL，不可用时自动降级为内置 SQLite，并在启动日志中提示
 * 服务端口 / 数据目录均可通过环境变量覆盖。
 */
const path = require('path');

const DATA_DIR = process.env.DEMO_DATA_DIR || path.join(__dirname, 'data');

module.exports = {
  server: {
    host: process.env.DEMO_HOST || '127.0.0.1',
    port: parseInt(process.env.DEMO_PORT || '8610', 10),
  },
  dataDir: DATA_DIR,
  registryDb: path.join(DATA_DIR, 'registry.sqlite'), // 应用注册表/配置/审计/结果（内置）
  business: {
    driver: process.env.DEMO_DRIVER || 'auto', // auto | mysql | sqlite
    sqliteFile: path.join(DATA_DIR, 'business.sqlite'), // 离线演示业务库
    mysql: {
      host: process.env.DEMO_MYSQL_HOST || 'mysql2.sqlpub.com',
      port: parseInt(process.env.DEMO_MYSQL_PORT || '3307', 10),
      database: process.env.DEMO_MYSQL_DB || 'nsjaccount',
      user: process.env.DEMO_MYSQL_USER || 'naccount',
      password: process.env.DEMO_MYSQL_PASSWORD || 'Uvwk51Z1PNZ6AtsA',
      connectTimeout: 6000,
    },
  },
  sessionMinutes: 30, // 会话/令牌有效期（技术规范：不超过30分钟）
  tablePrefix: 'sj_', // 业务模型物理表前缀，避免与库内既有表冲突
};
