/**
 * 服务：通用审批（模型发布 / API 发布·下线 等涉敏、批量操作的审核）。
 * 待审核对象统一入 sys_approval，由“结果审核人员/安全管理员/系统管理员”审批后驱动状态流转。
 */
'use strict';
const reg = require('../registry');
const auth = require('../auth');
const { now } = require('../util');

const APPROVER_ROLES = ['APPROVER', 'SECURITY_ADMIN', 'SYS_ADMIN'];

function canApprove(user) { return APPROVER_ROLES.includes(user.role); }

/** 若操作人不具备直接审核权限，则生成待办审批单 */
function submitOrAct(type, refType, refId, payload, proposer, actor) {
  if (canApprove(actor)) {
    reg.insert('sys_approval', {
      type, ref_type: refType, ref_id: refId, payload: JSON.stringify(payload), proposer,
      status: 'APPROVED', approver: actor.username, reason: '操作人具备审核权限，直接生效', created_at: now(), handled_at: now(),
    });
    return { need: false };
  }
  reg.insert('sys_approval', {
    type, ref_type: refType, ref_id: refId, payload: JSON.stringify(payload), proposer,
    status: 'PENDING', approver: '', reason: '', created_at: now(), handled_at: '',
  });
  return { need: true };
}

function listPending() {
  return reg.all(`SELECT * FROM sys_approval WHERE status='PENDING' ORDER BY id DESC`);
}
function listAll() { return reg.all(`SELECT * FROM sys_approval ORDER BY id DESC LIMIT 100`); }
function getApproval(id) { return reg.get(`SELECT * FROM sys_approval WHERE id=?`, [id]); }

/** 审批动作驱动注册好的副作用回调：type -> fn(payload, approve) */
const EFFECTS = {};

function onApprove(type, fn) { EFFECTS[type] = fn; }

function act(id, approve, actor, reason) {
  const a = getApproval(id);
  if (!a) throw new Error('审批单不存在');
  if (!canApprove(actor)) throw new Error('当前角色无审批权限');
  reg.run(`UPDATE sys_approval SET status=?, approver=?, reason=?, handled_at=? WHERE id=?`, [approve ? 'APPROVED' : 'REJECTED', actor.username, reason || '', now(), id]);
  const payload = JSON.parse(a.payload || '{}');
  if (approve) { const fn = EFFECTS[a.type]; if (fn) fn(payload, actor, a); }
  auth.audit(actor.username, actor.role, approve ? '审批通过' : '审批驳回', 'approval', id, `${a.type} #${a.ref_id} ${a.ref_type}`);
  return getApproval(id);
}

module.exports = { canApprove, submitOrAct, listPending, listAll, act, onApprove, APPROVER_ROLES };
