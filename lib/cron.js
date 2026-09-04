/**
 * 简化 Cron 解析/计算（支持 5 段：分 时 日 月 周；6 段：秒 分 时 日 月 周）。
 * 支持 星号、步长/间隔、范围、枚举。用于周期取数任务(F1-7)的下次执行时间计算与调度。
 */
'use strict';

function parseField(token, lo, hi) {
  const set = new Set();
  const range = (a, b) => { for (let i = a; i <= b; i++) set.add(i); };
  for (const part of String(token).split(',')) {
    const m = part.match(/^(\*|\d+)(?:\/(\d+))?(?:-(\d+))?$/);
    if (!m) throw new Error(`非法Cron字段: ${token}`);
    if (m[1] === '*') {
      const step = m[2] ? parseInt(m[2], 10) : 1;
      for (let i = lo; i <= hi; i += step) set.add(i);
    } else {
      const a = parseInt(m[1], 10);
      const b = m[3] ? parseInt(m[3], 10) : a;
      const step = m[2] ? parseInt(m[2], 10) : 1;
      if (a > b) throw new Error(`非法Cron区间: ${token}`);
      for (let i = a; i <= b; i += step) set.add(i);
    }
  }
  return [...set].sort((x, y) => x - y);
}

function parse(cron) {
  const parts = String(cron).trim().split(/\s+/);
  if (parts.length === 5) parts.unshift('0'); // 秒补 0
  if (parts.length !== 6) throw new Error('Cron须为5段或6段');
  return {
    sec: parseField(parts[0], 0, 59), min: parseField(parts[1], 0, 59), hour: parseField(parts[2], 0, 23),
    dom: parseField(parts[3], 1, 31), mon: parseField(parts[4], 1, 12), dow: parseField(parts[5], 0, 6),
  };
}

function match(parsed, d) {
  return parsed.sec.includes(d.getSeconds()) && parsed.min.includes(d.getMinutes())
    && parsed.hour.includes(d.getHours()) && parsed.dom.includes(d.getDate())
    && parsed.mon.includes(d.getMonth() + 1) && parsed.dow.includes(d.getDay());
}

/** 返回 after 之后的下一个触发时间(ms)；找不到返回 null（最远约5年） */
function nextRun(cron, after = Date.now()) {
  let p;
  try { p = parse(cron); } catch (e) { return null; }
  let t = Math.floor(after / 1000) + 1;
  const end = t + 5 * 366 * 24 * 60 * 60;
  // 按分钟粗扫，命中再精确到秒
  for (let m = Math.floor(t / 60); m * 60 <= end; m++) {
    const base = new Date(m * 60 * 1000);
    if (!p.min.includes(base.getMinutes()) || !p.hour.includes(base.getHours())
      || !p.dom.includes(base.getDate()) || !p.mon.includes(base.getMonth() + 1) || !p.dow.includes(base.getDay())) continue;
    const secs = p.sec.filter((s) => m * 60 + s > t);
    if (secs.length) return (m * 60 + secs[0]) * 1000;
  }
  return null;
}

function nextRuns(cron, after, count = 5) {
  const out = []; let t = after;
  for (let i = 0; i < count; i++) {
    const n = nextRun(cron, t);
    if (!n) break;
    out.push(new Date(n));
    t = n;
  }
  return out;
}

module.exports = { parse, match, nextRun, nextRuns };
