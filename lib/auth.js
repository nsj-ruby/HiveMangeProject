/**
 * 会话 / 权限 / 审计 / 消息。
 * RBAC：角色绑定最小权限集；审计记录所有关键操作；结果任务完成后通过站内消息通知。
 */
'use strict';
const reg = require('./registry');
const { verifyUi } = require('./crypto');
const { now, json } = require('./util');

const SUPER = 'SYS_ADMIN';

function resolveUser(token) {
  const c = verifyUi(token);
  if (!c) return null;
  return { username: c.sub, name: c.name, role: c.role };
}

/** 判断角色是否具备权限（SYS_ADMIN 兜底）；若未传 required 表示仅需登录 */
function can(user, required) {
  if (!user) return false;
  if (user.role === SUPER) return true;
  if (!required || required.length === 0) return true;
  return required.includes(user.role);
}

function audit(actor, role, action, objectType, objectId, detail, ip = '', result = 'OK') {
  try {
    reg.insert('sys_audit', {
      actor: actor || '-', role: role || '', action, object_type: objectType || '',
      object_id: objectId == null ? '' : String(objectId),
      detail: typeof detail === 'string' ? detail.slice(0, 2000) : json(detail).slice(0, 2000),
      ip: ip || '', result, created_at: now(),
    });
  } catch (e) { /* 审计失败不阻断 */ }
}

function notify(username, title, body) {
  reg.insert('sys_msg', { username, title, body, read: 0, created_at: now() });
}
function unreadCount(username) {
  const r = reg.get(`SELECT COUNT(*) AS c FROM sys_msg WHERE username=? AND read=0`, [username]);
  return r ? r.c : 0;
}
function messages(username) {
  return reg.all(`SELECT * FROM sys_msg WHERE username=? ORDER BY id DESC LIMIT 30`, [username]);
}
function markRead(id) { reg.run(`UPDATE sys_msg SET read=1 WHERE id=?`, [id]); }

module.exports = { resolveUser, can, audit, notify, unreadCount, messages, markRead, SUPER };
