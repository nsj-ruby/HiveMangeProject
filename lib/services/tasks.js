/**
 * 服务：取数流程 / 取数任务管理（F1-4 / F1-7）。
 *  - 流程 CRUD + 分步执行与预览（引擎按步骤推进）
 *  - 任务：即时 / 周期(Cron)，状态机（待执行→执行中→成功/失败/终止）
 *  - 后台调度循环 + 结果集有效期清理 + 失败重试 + 完成通知
 */
'use strict';
const reg = require('../registry');
const auth = require('../auth');
const engine = require('../engine');
const cronMod = require('../cron');
const { now, json } = require('../util');

const TASK_STATUS = ['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'TERMINATED'];
const RUN_EXPIRE_DAYS = 7;
const running = new Set();

// ---------------- 流程 ----------------
function listFlows() {
  const flows = reg.all(`SELECT * FROM sys_flow ORDER BY id DESC`);
  for (const f of flows) { if (typeof f.config === 'string') { try { f.config = JSON.parse(f.config || '{}'); } catch (e) { f.config = {}; } } }
  return flows;
}
function getFlow(id) {
  const f = reg.get(`SELECT * FROM sys_flow WHERE id=?`, [id]);
  if (f) f.config = JSON.parse(f.config || '{}');
  return f;
}
function saveFlow(payload, user) {
  const cfg = payload.config || {};
  const nowStr = now();
  if (payload.id) {
    const ex = reg.get(`SELECT * FROM sys_flow WHERE id=?`, [payload.id]);
    if (!ex) throw new Error('流程不存在');
    const newCfg = cfg;
    const version = (payload.bumpVersion ? (ex.version || 1) + 1 : ex.version || 1);
    reg.run(`UPDATE sys_flow SET flow_name=?, config=?, version=?, updated_at=? WHERE id=?`, [payload.flow_name || ex.flow_name, json(newCfg), version, nowStr, payload.id]);
    auth.audit(user.username, user.role, '取数流程修改', 'flow', payload.id, payload.flow_name + ' v' + version);
    return getFlow(payload.id);
  }
  const id = reg.insert('sys_flow', {
    flow_code: 'F' + Date.now().toString(36).toUpperCase(), flow_name: payload.flow_name || '未命名取数流程',
    config: json(cfg), status: 'DRAFT', version: 1, owner: user.username, created_at: nowStr, updated_at: nowStr,
  });
  auth.audit(user.username, user.role, '取数流程新建', 'flow', id, payload.flow_name);
  return getFlow(id);
}
function deleteFlow(id, user) {
  const used = reg.get(`SELECT COUNT(*) AS c FROM sys_task WHERE flow_id=?`, [id]);
  if (used.c > 0) throw new Error('该流程已被取数任务引用，不能删除');
  reg.run(`DELETE FROM sys_flow WHERE id=?`, [id]);
  auth.audit(user.username, user.role, '取数流程删除', 'flow', id, '');
}
function renameFlow(id, name, user) {
  reg.run(`UPDATE sys_flow SET flow_name=?, updated_at=? WHERE id=?`, [name, now(), id]);
  auth.audit(user.username, user.role, '取数流程重命名', 'flow', id, name);
}

// ---------------- 预览（配置过程分步执行 F1-6） ----------------
async function preview(config, until, role) {
  const issues = engine.validate(config, getModels(config));
  return engine.runFlow(config, { until, role });
}
function getModels(config) {
  return (config.models || []).map((id) => require('./models').getModel(id));
}

// ---------------- 任务 ----------------
function listTasks() {
  const tasks = reg.all(`SELECT t.*, f.flow_name FROM sys_task t LEFT JOIN sys_flow f ON f.id=t.flow_id ORDER BY t.id DESC`);
  for (const t of tasks) {
    const last = reg.get(`SELECT * FROM sys_run WHERE task_id=? ORDER BY id DESC LIMIT 1`, [t.id]);
    t.last_run = last;
  }
  return tasks;
}
function getTask(id) {
  const t = reg.get(`SELECT t.*, f.flow_name FROM sys_task t LEFT JOIN sys_flow f ON f.id=t.flow_id WHERE t.id=?`, [id]);
  if (t) t.runs = reg.all(`SELECT * FROM sys_run WHERE task_id=? ORDER BY id DESC LIMIT 20`, [id]);
  return t;
}
function createTask(payload, user) {
  const flow = getFlow(payload.flow_id);
  if (!flow) throw new Error('流程不存在');
  const exeType = payload.exec_type || 'ONCE';
  let nextAt = null;
  if (exeType === 'CRON') {
    const nx = cronMod.nextRun(payload.cron, Date.now());
    if (nx == null) throw new Error('Cron 表达式不合法或5年内无触发时间');
    nextAt = new Date(nx).toISOString().slice(0, 19).replace('T', ' ');
  }
  const id = reg.insert('sys_task', {
    task_code: 'T' + Date.now().toString(36).toUpperCase(),
    task_name: payload.task_name || (flow.flow_name + '-任务'),
    flow_id: payload.flow_id, exec_type: exeType, cron: payload.cron || '',
    cron_desc: payload.cron_desc || '', status: 'PENDING', owner: user.username,
    retry: payload.retry || 0, retry_left: payload.retry || 0, enabled: 1,
    schedule_from: payload.schedule_from || '', schedule_to: payload.schedule_to || '',
    next_run_at: nextAt, created_at: now(), updated_at: now(),
  });
  auth.audit(user.username, user.role, '取数任务创建', 'task', id, `${payload.task_name}(${exeType})`);
  return getTask(id);
}

function scheduleNext(task) {
  if (task.exec_type === 'CRON') {
    const nx = cronMod.nextRun(task.cron, Date.now());
    if (nx == null || (task.schedule_to && new Date(nx).toISOString().slice(0, 10) > task.schedule_to)) {
      reg.run(`UPDATE sys_task SET enabled=0, updated_at=? WHERE id=?`, [now(), task.id]);
      return;
    }
    reg.run(`UPDATE sys_task SET next_run_at=?, updated_at=? WHERE id=?`, [new Date(nx).toISOString().slice(0, 19).replace('T', ' '), now(), task.id]);
  }
}

/** 真正执行一次任务，生成一次运行记录 */
async function executeTask(taskId, opts = {}) {
  const task = getTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (running.has(taskId)) throw new Error('任务正在执行中');
  running.add(taskId);
  reg.run(`UPDATE sys_task SET status='RUNNING', error='', last_run_at=?, updated_at=? WHERE id=?`, [now(), now(), taskId]);
  const start = Date.now();
  const flow = getFlow(task.flow_id);
  const runNo = (reg.get(`SELECT COALESCE(MAX(run_no),0)+1 AS n FROM sys_run WHERE task_id=?`, [taskId]).n) || 1;
  let recordId;
  try {
    const result = await engine.runFlow(flow.config, { needMask: false });
    recordId = reg.insert('sys_run', {
      task_id: taskId, run_no: runNo, status: 'SUCCESS', started_at: now(),
      finished_at: null, duration_ms: 0, result: json({ columns: result.columns, rows: result.rows, sql: result.sql }),
      row_count: result.rows.length, error: '', cleared: 0,
      expire_at: new Date(Date.now() + RUN_EXPIRE_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' '),
      created_at: now(),
    });
    const dur = Date.now() - start;
    reg.run(`UPDATE sys_run SET finished_at=?, duration_ms=? WHERE id=?`, [now(), dur, recordId]);
    reg.run(`UPDATE sys_task SET status='SUCCESS', row_count=?, updated_at=? WHERE id=?`, [result.rows.length, now(), taskId]);
    auth.audit(task.owner, task.owner, '取数任务执行成功', 'task', taskId, `运行#${runNo} 结果${result.rows.length}行 耗时${dur}ms`);
    auth.notify(task.owner, `取数任务执行成功`, `任务「${task.task_name}」运行#${runNo}完成，产出 ${result.rows.length} 行，耗时 ${(dur / 1000).toFixed(1)}s。`);
    if (task.exec_type === 'CRON') scheduleNext(task);
    return { ok: true, runId: recordId, rows: result.rows.length, duration: dur };
  } catch (e) {
    const dur = Date.now() - start;
    recordId = reg.insert('sys_run', {
      task_id: taskId, run_no: runNo, status: 'FAILED', started_at: now(), finished_at: now(),
      duration_ms: dur, result: '{}', row_count: 0, error: String(e.message || e), cleared: 0,
      expire_at: '', created_at: now(),
    });
    const rl = Math.max(0, (task.retry_left || 0) - 1);
    reg.run(`UPDATE sys_task SET status='FAILED', error=?, retry_left=?, updated_at=? WHERE id=?`, [String(e.message || e), rl, now(), taskId]);
    auth.audit(task.owner, task.owner, '取数任务执行失败', 'task', taskId, String(e.message || e), '', 'FAIL');
    auth.notify(task.owner, `取数任务执行失败`, `任务「${task.task_name}」运行#${runNo}失败：${String(e.message || e).slice(0, 200)}`);
    if (!opts.noRetry && rl > 0 && (task.retry || 0) > 0) {
      // 立即重试一次
      reg.run(`UPDATE sys_task SET retry_left=? WHERE id=?`, [rl, taskId]);
      return executeTask(taskId, { noRetry: true });
    }
    throw e;
  } finally {
    running.delete(taskId);
  }
}

async function runTaskNow(taskId, user) {
  try {
    await executeTask(taskId);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
function terminateTask(id, user) {
  reg.run(`UPDATE sys_task SET status='TERMINATED', enabled=0, error='已由用户终止', updated_at=? WHERE id=?`, [now(), id]);
  auth.audit(user.username, user.role, '取数任务终止', 'task', id, '');
  return getTask(id);
}
function deleteTask(id, user) {
  reg.run(`DELETE FROM sys_run WHERE task_id=?`, [id]);
  reg.run(`DELETE FROM sys_task WHERE id=?`, [id]);
  auth.audit(user.username, user.role, '取数任务删除', 'task', id, '');
}
function getRun(id) {
  const r = reg.get(`SELECT * FROM sys_run WHERE id=?`, [id]);
  if (r) { r.payload = JSON.parse(r.result || '{}'); }
  return r;
}
function deleteRun(id) { reg.run(`DELETE FROM sys_run WHERE id=?`, [id]); }

// ---------------- 调度循环 ----------------
let timer = null;
function startScheduler() {
  if (timer) clearInterval(timer);
  timer = setInterval(async () => {
    const nowIso = new Date(Date.now() - 1000).toISOString().slice(0, 19).replace('T', ' ');
    const due = reg.all(`SELECT id FROM sys_task WHERE enabled=1 AND exec_type='CRON' AND next_run_at IS NOT NULL AND next_run_at<=? AND status!='RUNNING'`, [nowIso]);
    for (const t of due) {
      try { await executeTask(t.id); } catch (e) { /* 失败已记录 */ }
    }
    cleanupExpired();
  }, 2000);
}
function cleanupExpired() {
  const nowIso = now();
  const del = reg.run(`UPDATE sys_run SET cleared=1, result='{}' WHERE expire_at<>'' AND expire_at<=? AND cleared=0`, [nowIso]);
}
function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = {
  listFlows, getFlow, saveFlow, deleteFlow, renameFlow, preview,
  listTasks, getTask, createTask, executeTask, runTaskNow, terminateTask, deleteTask, getRun, deleteRun,
  startScheduler, stopScheduler, cleanupExpired, TASK_STATUS,
};
