/**
 * 组合分析执行引擎（F1-1 ~ F1-6 的加工核心）。
 * 将“分析流程配置(flow config)”按步骤顺序执行：
 *   数据源关联(join) → 条件筛选 → 聚合(sum/avg/...) → 派生计算(四则) → 字段转换(自定义函数)
 *   → 去重 → 排序/TopN → 结果输出
 * 所有数值加工在服务端完成；输出层统一调用字段脱敏(F3-2)，保证任何环节形态一致、不可绕过。
 */
'use strict';
const bizMod = require('./biz');
const modelsSvc = require('./services/models');
const funcsSvc = require('./services/funcs');
const desen = require('./desensitize');
const { q, toNumber, round, parse, json } = require('./util');

const OPS = {
  eq: '等于', ne: '不等于', gt: '大于', ge: '大于等于', lt: '小于', le: '小于等于',
  in: '属于', contains: '包含', startsWith: '开头为', isNull: '为空', notNull: '不为空', between: '介于',
};
const AGGS = { sum: '求和', avg: '平均值', count: '计数', countd: '去重计数', max: '最大值', min: '最小值' };

// ---------------- 表达式解析（递归下降：数字 + {字段} + 函数调用，不支持任意JS） ----------------
function tokenize(expr) {
  const re = /\s*([0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_.]*|\{[\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_.]*\}|[()+\-*/,])\s*/g;
  const out = []; let m; let last = 0;
  while ((m = re.exec(expr))) { if (m.index !== last) throw new Error(`表达式含非法字符: "${expr.slice(last, m.index)}"`); out.push(m[1]); last = re.lastIndex; }
  if (last !== expr.length) throw new Error(`表达式含非法字符: "${expr.slice(last)}"`);
  if (!out.length) throw new Error('表达式为空');
  return out;
}

function createParser(tokens, row, fns) {
  let pos = 0;
  const self = { get pos() { return pos; } };
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseExpr() { return parseAdd(); }
  function parseAdd() {
    let v = parseMul();
    while (peek() === '+' || peek() === '-') { const op = next(); const r = parseMul(); v = v == null || r == null ? null : (op === '+' ? v + r : v - r); }
    return v;
  }
  function parseMul() {
    let v = parseUnary();
    while (peek() === '*' || peek() === '/') { const op = next(); const r = parseUnary(); v = v == null || r == null ? null : (op === '*' ? v * r : (r === 0 ? null : v / r)); }
    return v;
  }
  function parseUnary() {
    if (peek() === '-') { next(); const v = parseUnary(); return v == null ? null : -v; }
    if (peek() === '+') { next(); return parseUnary(); }
    return parseAtom();
  }
  function parseAtom() {
    const t = next();
    if (t === '(') { const v = parseExpr(); if (next() !== ')') throw new Error('括号不匹配'); return v; }
    if (/^\{.*\}$/.test(t)) { const key = t.slice(1, -1); const v = row[key]; return v == null || v === '' ? null : toNumber(v); }
    if (/^\d/.test(t)) return Number(t);
    // 函数调用 func(args)
    if (peek() === '(') {
      next();
      const args = [];
      if (peek() !== ')') { args.push(parseExpr()); while (peek() === ',') { next(); args.push(parseExpr()); } }
      if (next() !== ')') throw new Error('函数调用括号不匹配');
      const f = fns[t];
      if (typeof f !== 'function') throw new Error(`不支持的函数 ${t}`);
      const v = f(...args);
      return v == null || v === '' ? null : toNumber(v);
    }
    throw new Error(`未知标识符 ${t}`);
  }
  self.parseExpr = parseExpr;
  return self;
}

function evalExpr(expr, row, fns) {
  const tokens = tokenize(expr);
  const p = createParser(tokens, row, fns);
  const v = p.parseExpr();
  if (p.pos !== tokens.length) throw new Error('表达式存在多余内容');
  return v;
}

// ---------------- 条件过滤 ----------------
function cmpVal(v) {
  if (v == null) return v;
  const n = toNumber(v);
  return typeof n === 'number' ? n : String(v);
}
function matchCond(row, cond) {
  const v = row[cond.field];
  const target = cond.value;
  switch (cond.op) {
    case 'eq': return cmpVal(v) == cmpVal(target);
    case 'ne': return cmpVal(v) != cmpVal(target);
    case 'gt': return cmpVal(v) > cmpVal(target);
    case 'ge': return cmpVal(v) >= cmpVal(target);
    case 'lt': return cmpVal(v) < cmpVal(target);
    case 'le': return cmpVal(v) <= cmpVal(target);
    case 'in': return (target || []).map(String).includes(String(v == null ? '' : v));
    case 'contains': return String(v == null ? '' : v).includes(String(target == null ? '' : target));
    case 'startsWith': return String(v == null ? '' : v).startsWith(String(target == null ? '' : target));
    case 'isNull': return v == null || v === '';
    case 'notNull': return v != null && v !== '';
    case 'between': return cmpVal(v) >= cmpVal(target && target[0]) && cmpVal(v) <= cmpVal(target && target[1]);
    default: return true;
  }
}
function applyFilter(rows, conds, logic = 'and') {
  if (!conds || !conds.length) return rows;
  return rows.filter((r) => conds.map((c) => matchCond(r, c)).reduce((a, b) => (logic === 'or' ? a || b : a && b), logic === 'or' ? false : true));
}

// ---------------- 聚合 ----------------
function aggregate(rows, colMap, groupFields, aggs, opt = {}) {
  const groups = new Map();
  for (const r of rows) {
    const gk = groupFields.map((f) => String(r[f] == null ? '' : r[f])).join('\u0001');
    if (!groups.has(gk)) {
      const row = {};
      for (const f of groupFields) row[f] = r[f];
      for (const a of aggs) {
        row[a.alias] = a.op === 'count' ? 0 : (a.op === 'countd' ? new Set() : 0);
        if (a.op === 'countd') { row['__set_' + a.alias] = new Set(); }
      }
      groups.set(gk, row);
    }
    const row = groups.get(gk);
    for (const a of aggs) {
      const raw = r[a.field];
      const n = toNumber(raw);
      const s = row['__set_' + a.alias];
      if (a.op === 'sum') { if (n != null && typeof n === 'number') row[a.alias] += n; }
      else if (a.op === 'avg') {
        if (n != null && typeof n === 'number') { row[a.alias + 'n'] = (row[a.alias + 'n'] || 0) + n; row[a.alias + 'c'] = (row[a.alias + 'c'] || 0) + 1; }
      } else if (a.op === 'count') row[a.alias] += 1;
      else if (a.op === 'countd') { if (raw != null) s.add(String(raw)); }
      else if (a.op === 'max') { if (n != null && typeof n === 'number') row[a.alias] = Math.max(row[a.alias], n); }
      else if (a.op === 'min') { if (n != null && typeof n === 'number') row[a.alias] = Math.min(row[a.alias], n); }
    }
  }
  return [...groups.values()].map((r) => {
    const out = {};
    for (const k of Object.keys(r)) if (!k.startsWith('__set_')) out[k] = r[k];
    for (const a of aggs) {
      if (a.op === 'countd') out[a.alias] = r['__set_' + a.alias].size;
      if (a.op === 'avg') {
        const cnt = out[a.alias + 'c'];
        out[a.alias] = cnt ? round(out[a.alias + 'n'] / cnt, a.decimal == null ? 2 : a.decimal) : null;
        delete out[a.alias + 'n']; delete out[a.alias + 'c'];
      } else if (typeof out[a.alias] === 'number' && a.decimal != null) out[a.alias] = round(out[a.alias], a.decimal);
    }
    return out;
  });
}

// ---------------- 数据源加载与关联 ----------------
async function loadModelRows(modelId, neededFields) {
  const m = modelsSvc.getModel(modelId);
  const biz = await bizMod.getBiz();
  let sql = `SELECT ${neededFields.map(q).join(',')} FROM ${q(m.physical_table)} LIMIT 20000`;
  const rows = await biz.query(sql);
  return { m, rows };
}

function colTypeStr(f) {
  const t = String(f.field_type || '').split('(')[0].toUpperCase();
  if (/INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL|TINY|BIGINT/.test(t)) return 'NUMBER';
  if (/DATE|TIME/.test(t)) return 'DATETIME';
  return 'STRING';
}

/**
 * 执行流程：返回 { columns:[{alias, cn, field, type, sens, model}], rows, sql, logs }
 * until: 执行到第几个 step（含），默认全部
 */
async function runFlow(cfg, { until = 9999, needMask = true, role = 'ANALYST' } = {}) {
  const logs = [];
  const t0 = Date.now();
  const models = cfg.models || [];
  const modelInfos = models.map((id) => modelsSvc.getModel(id));
  if (modelInfos.some((x) => !x)) throw new Error('所选模型中存在未发布或不存在模型');
  const pub = modelInfos.filter((x) => x.status === 'PUBLISHED');
  if (pub.length !== modelInfos.length) throw new Error('模型需先“发布”后才能参与组合分析');
  if (modelInfos.length < 2) throw new Error('组合分析需选择2个及以上数据模型（F1-1）');

  // 1) 生成别名与字段元
  const aliasMap = new Map(); // alias -> spec
  const modelAlias = (i) => 'm' + (i + 1);
  for (let i = 0; i < modelInfos.length; i++) {
    const mi = modelInfos[i];
    const prefix = modelAlias(i) + '_';
    for (const f of mi.fields) {
      const candidate = f.field_name;
      const alias = aliasMap.has(candidate) ? prefix + f.field_name : candidate;
      aliasMap.set(alias, {
        alias, cn: f.field_cn || f.field_name, field: f.field_name, type: colTypeStr(f),
        sens: !!f.is_sensitive, mask_alg: f.mask_alg, mask_params: f.mask_params,
        role_exempt: f.role_exempt, modelId: mi.id, modelName: mi.model_name,
      });
    }
    logs.push(`数据源：加载模型 ${mi.model_name}(${mi.physical_table})，字段 ${mi.fields.length} 个`);
  }

  // 2) 按需加载各模型数据并关联
  const modelRows = {};
  for (let i = 0; i < modelInfos.length; i++) {
    const mi = modelInfos[i];
    const need = mi.fields.map((f) => f.field_name);
    modelRows[mi.id] = (await loadModelRows(mi.id, need)).rows;
  }
  const joins = (cfg.joins && cfg.joins.length) ? cfg.joins : await autoJoins(modelInfos);
  if (!joins.length) throw new Error('模型间未配置关联条件，无法执行（请先配置模型关系或手工指定关联）');

  // 起始集 = 第一个模型
  const baseModel = modelInfos[0];
  let dataset = modelRows[baseModel.id].map((r) => {
    const o = {};
    for (const s of aliasMap.values()) if (s.modelId === baseModel.id && r[s.field] !== undefined) o[s.alias] = r[s.field];
    return o;
  });
  const joinedSet = new Set([baseModel.id]);
  const joinLogs = [];
  for (const j of joins) {
    let left = modelInfos.find((x) => x.id === j.left.model);
    let right = modelInfos.find((x) => x.id === j.right.model);
    if (!left || !right) continue;
    if (joinedSet.has(right.id) && !joinedSet.has(left.id)) { const t = left; left = right; right = t; }
    if (!joinedSet.has(left.id)) continue; // 等前面先连接
    if (joinedSet.has(right.id)) { joinLogs.push(`跳过重复关联 ${left.model_name}↔${right.model_name}`); continue; }
    const lk = j.left.fields, rk = j.right.fields;
    const rMap = new Map();
    const rightRows = modelRows[right.id];
    for (const rr of rightRows) {
      const key = rk.map((f) => String(rr[f] == null ? '' : rr[f])).join('\u0001');
      if (!rMap.has(key)) rMap.set(key, []);
      rMap.get(key).push(rr);
    }
    const leftKeys = new Set();
    for (const rr of rightRows) leftKeys.add(rk.map((f) => String(rr[f] == null ? '' : rr[f])).join('\u0001'));
    const rightAlias = [...aliasMap.values()].filter((s) => s.modelId === right.id);
    const type = (j.type || 'INNER').toUpperCase();
    const out = [];
    for (const row of dataset) {
      const key = lk.map((f) => String(row[f] == null ? '' : row[f])).join('\u0001');
      const matches = rMap.get(key) || [];
      const add = (rr) => {
        const o = { ...row };
        for (const s of rightAlias) o[s.alias] = rr[s.field];
        out.push(o);
      };
      if (matches.length) for (const rr of matches) add(rr);
      else if (type === 'LEFT' || type === 'FULL') add(null);
    }
    if (type === 'RIGHT' || type === 'FULL') {
      const existing = new Set(dataset.map((r) => lk.map((f) => String(r[f] == null ? '' : r[f])).join('\u0001')));
      const leftAlias = [...aliasMap.values()].filter((s) => s.modelId === left.id);
      for (const [key, rows2] of rMap) {
        if (existing.has(key)) continue;
        for (const rr of rows2) {
          const o = {};
          for (const s of leftAlias) o[s.alias] = null;
          for (const s of rightAlias) o[s.alias] = rr[s.field];
          out.push(o);
        }
      }
    }
    dataset = out;
    joinedSet.add(right.id);
    joinLogs.push(`关联：${left.model_name}.${j.left.fields.join('+')} ${type} ${right.model_name}.${j.right.fields.join('+')} → ${out.length} 行`);
  }
  logs.push(...joinLogs);

  // 3) 执行步骤链
  const steps = cfg.steps || [];
  let stepCols = (() => { const c = []; for (const s of aliasMap.values()) if (!c.find((x) => x.alias === s.alias)) c.push({ ...s }); return c; })();
  const fnsCtx = { ABS: Math.abs, ROUND: (v, d) => round(v, d), GREATEST: (...a) => Math.max(...a.filter((x) => x != null).concat([0])), IFNULL: (v, d) => (v == null ? d : v) };

  for (let si = 0; si < steps.length; si++) {
    if (until >= 0 && si >= until) break; // until<0 表示执行全部步骤
    const step = steps[si];
    logs.push(`步骤${si + 1} ${stepDesc(step)}`);
    switch (step.type) {
      case 'filter': {
        dataset = applyFilter(dataset, step.conditions, step.logic);
        logs.push(`  ├─ 筛选后剩余 ${dataset.length} 行`);
        break;
      }
      case 'aggregate': {
        const before = dataset.length;
        dataset = aggregate(dataset, stepCols, step.group || [], step.aggs || [], step);
        // 补充聚合结果字段定义
        for (const a of step.aggs || []) {
          stepCols.push({ alias: a.alias, cn: a.alias, field: a.field, type: 'NUMBER', sens: false, agg: AGGS[a.op] || a.op });
        }
        // 聚合后列集只保留：分组字段 + 聚合结果字段（未参与聚合的原字段不再出现）
        const keep = new Set([...(step.group || []), ...(step.aggs || []).map((a) => a.alias)]);
        stepCols = stepCols.filter((c) => keep.has(c.alias));
        if (step.postFilters && step.postFilters.length) dataset = applyFilter(dataset, step.postFilters, 'and');
        logs.push(`  ├─ 分组维度 ${(step.group || []).join('、') || '(整体)'}，聚合字段 ${(step.aggs || []).map((a) => a.alias).join('、')}，${before} → ${dataset.length} 行`);
        break;
      }
      case 'calc': {
        const exprs = step.exprs || [];
        for (const e of exprs) {
          const withFn = { ...fnsCtx };
          // 支持注册的自定义函数（numeric 派生场景）
          const needF = (code) => (a) => { try { return toNumber(funcsSvc.callByCode(code, a)); } catch (err) { throw err; } };
          dataset = dataset.map((r) => {
            const row = { ...r };
            for (const ex of exprs) {
              const v = evalExpr(ex.expr, row, { ...fnsCtx, ...(ex.funcs || []).reduce((o, fn) => { try { o[fn] = needF(fn); } catch (e) {} return o; }, {}) });
              row[ex.alias] = v == null ? (ex.zero === '0' ? 0 : null) : (typeof v === 'number' && ex.decimal != null ? round(v, ex.decimal) : v);
            }
            return row;
          });
          stepCols.push({ alias: e.alias, cn: e.alias, field: '', type: 'NUMBER', sens: false, expr: e.expr });
        }
        logs.push(`  ├─ 派生字段：${exprs.map((e) => `${e.alias} = ${e.expr}`).join('；') || '无'}`);
        break;
      }
      case 'convert': {
        const maps = step.mappings || [];
        dataset = dataset.map((r) => {
          const row = { ...r };
          for (const map of maps) {
            const args = (map.args || []).map((a) => (a.kind === 'const' ? a.value : row[a.value]));
            const v = funcsSvc.callByCode(map.func, args);
            const target = map.outAlias || map.alias;
            row[target] = v;
            if (!stepCols.find((c) => c.alias === target)) stepCols.push({ alias: target, cn: target, field: '', type: 'STRING', sens: false, func: map.func });
          }
          return row;
        });
        logs.push(`  ├─ 字段转换：${maps.map((m) => `${m.func}(${m.args.map((a) => a.value).join(',')})→${m.outAlias}`).join('；') || '无'}`);
        break;
      }
      case 'sort': {
        const sorts = step.sort || [];
        dataset = [...dataset].sort((a, b) => {
          for (const s of sorts) {
            const av = cmpVal(a[s.field]), bv = cmpVal(b[s.field]);
            let r = 0;
            if (av == null && bv == null) r = 0; else if (av == null) r = -1; else if (bv == null) r = 1;
            else r = av > bv ? 1 : av < bv ? -1 : 0;
            if (r) return s.dir === 'desc' ? -r : r;
          }
          return 0;
        });
        if (step.topN && step.topN > 0) dataset = dataset.slice(0, step.topN);
        logs.push(`  ├─ 排序 ${(sorts || []).map((s) => `${s.field} ${s.dir}`).join('、')}${step.topN ? `，Top ${step.topN}` : ''}`);
        break;
      }
      case 'dedup': {
        const fields = step.fields && step.fields.length ? step.fields : stepCols.map((c) => c.alias);
        const seen = new Set();
        dataset = dataset.filter((r) => { const k = fields.map((f) => String(r[f] == null ? '' : r[f])).join('\u0001'); if (seen.has(k)) return false; seen.add(k); return true; });
        logs.push(`  ├─ 按 ${fields.join('、')} 去重 → ${dataset.length} 行`);
        break;
      }
      case 'output': {
        if (step.fields && step.fields.length) {
          const keepF = new Set(step.fields);
          dataset = dataset.map((r) => { const o = {}; for (const k of step.fields) o[k] = r[k]; return o; });
          stepCols = stepCols.filter((c) => keepF.has(c.alias));
        }
        if (step.limit && step.limit > 0) dataset = dataset.slice(0, step.limit);
        logs.push(`  ├─ 输出字段 ${(step.fields || stepCols.map((c) => c.alias)).join('、')}，行数 ${dataset.length}`);
        break;
      }
      default: throw new Error(`不支持的步骤类型 ${step.type}`);
    }
  }

  // 4) 统一列序；自动隐藏“整列为空”的字段（预览/执行/结果/API 一致，不展示无值列）
  let cols = stepCols;
  const data = dataset;
  if (data.length) {
    const alive = new Set();
    for (const r of data) for (const c of cols) { const v = r[c.alias]; if (v != null && v !== '') alive.add(c.alias); }
    cols = cols.filter((c) => alive.has(c.alias));
  }
  // 数值化展示（导出/接口），但敏感字段保持原始以便脱敏
  const sql = translateToSql(cfg, cols, modelInfos);
  const duration = Date.now() - t0;
  if (needMask) {
    return { columns: cols, rows: maskRows(data, cols, role), sql, logs, duration, total: data.length };
  }
  return { columns: cols, rows: data, sql, logs, duration, total: data.length };
}

function stepDesc(step) {
  const d = {
    source: '数据源与关联', filter: '条件筛选', aggregate: '聚合计算', calc: '派生计算',
    convert: '字段转换(函数)', dedup: '数据去重', sort: '排序与TopN', output: '结果输出',
  };
  return (d[step.type] || step.type) + (step.name ? `(${step.name})` : '');
}

/** 将引擎列元信息规范化为脱敏器所需字段结构 */
function toMaskField(c) {
  return {
    is_sensitive: !!c.sens || !!c.is_sensitive,
    mask_alg: c.mask_alg || '', mask_params: c.mask_params || '{}',
    role_exempt: c.role_exempt || '[]', field_name: c.alias || c.field_name,
  };
}

/** 对结果集按列元信息统一脱敏（输出层，F3-2 全局生效） */
function maskRows(rows, cols, role) {
  return rows.map((r) => {
    const o = { ...r };
    for (const c of cols) {
      const sens = c.sens || c.is_sensitive;
      if (sens && o[c.alias] != null && o[c.alias] !== '') o[c.alias] = desen.apply(toMaskField(c), o[c.alias], role);
    }
    return o;
  });
}

function maskValue(col, v, role) { return col && (col.sens || col.is_sensitive) ? desen.apply(toMaskField(col), v, role) : v; }

// 自动推荐关联（F1-1 效果5：基于模型关系配置自动推荐）
async function autoJoins(modelInfos) {
  const ids = modelInfos.map((m) => m.id);
  const rels = modelsSvc.recommendFor(ids);
  const joins = [];
  for (const r of rels) {
    joins.push({
      type: r.rel_type, left: { model: r.left_model_id, fields: JSON.parse(r.left_fields) },
      right: { model: r.right_model_id, fields: JSON.parse(r.right_fields) },
      fromRecommend: true,
    });
  }
  return joins;
}

// ---------------- 校验配置（执行前/保存前） ----------------
function validate(cfg, modelInfos) {
  const issues = [];
  const ids = (cfg.models || []).map(Number);
  if (ids.length < 2) issues.push('需选择2个及以上数据模型');
  const rels = modelsSvc.recommendFor(ids);
  if ((!cfg.joins || !cfg.joins.length) && !rels.length) issues.push('所选模型间未配置关系，请先配置模型关系或手工设置关联');
  // 非数值字段被聚合（仅对已发布模型）
  const fieldMap = new Map();
  for (const mi of modelInfos) for (const f of mi.fields) fieldMap.set(mi.id + '.' + f.field_name, f);
  for (const step of cfg.steps || []) {
    if (step.type === 'aggregate') {
      const g = step.group || [];
      const aggAliases = new Set(g);
      if (!g.length && (step.aggs || []).length === 0) issues.push('聚合步骤需配置分组维度或聚合字段');
      for (const a of step.aggs || []) {
        const info = fieldMap.get(a.field);
        if (info) {
          const t = String(info.field_type).toUpperCase();
          const isNum = /INT|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL/.test(t);
          if (!isNum && ['sum', 'avg'].includes(a.op)) issues.push(`字段“${info.field_cn}(${a.field})”非数值型，不能配置${a.op === 'sum' ? '求和' : '平均值'}`);
        }
      }
    }
    if (step.type === 'calc') {
      for (const e of step.exprs || []) {
        try {
          const p = createParser(tokenize(e.expr), {}, new Proxy({}, { get: () => () => 0 }));
          p.parseExpr();
          if (p.pos !== tokenize(e.expr).length) throw new Error('表达式存在多余内容');
        } catch (err) { issues.push(`派生字段 ${e.alias} 表达式语法错误：${err.message}`); }
      }
    }
  }
  return issues;
}

// ---------------- SQL 预览（F1-6 技术透明：展示等价SQL） ----------------
function translateToSql(cfg, cols, modelInfos) {
  const lines = [];
  const models = modelInfos || [];
  const src = models.map((m) => `\`${m.physical_table}\` ${'m' + (models.indexOf(m) + 1)}`).join(',\n  ');
  const joins = cfg.joins || [];
  let from = models[0] ? `\`${models[0].physical_table}\`` : '';
  for (let i = 0; i < joins.length && models.length; i++) {
    const j = joins[i];
    const lm = models.find((x) => x.id === j.left.model);
    const rm = models.find((x) => x.id === j.right.model);
    if (!lm || !rm) continue;
    const on = j.left.fields.map((f, idx) => `m${models.indexOf(lm) + 1}.\`${f}\` = m${models.indexOf(rm) + 1}.\`${j.right.fields[idx]}\``).join(' AND ');
    from += `\n  ${j.type} JOIN \`${rm.physical_table}\` m${models.indexOf(rm) + 1} ON ${on}`;
  }
  const whereConds = [];
  const havingConds = [];
  let groupCols = null, orderConds = [], limit = null, distinct = false, extraSelect = [];
  const steps = cfg.steps || [];
  for (const st of steps) {
    if (st.type === 'filter') for (const c of st.conditions || []) whereConds.push(condSql(c));
    else if (st.type === 'aggregate') {
      groupCols = st.group || [];
      for (const a of st.aggs || []) {
        const col = `\`${a.field}\``;
        if (a.op === 'count') extraSelect.push(`COUNT(1) AS \`${a.alias}\``);
        else if (a.op === 'countd') extraSelect.push(`COUNT(DISTINCT ${col}) AS \`${a.alias}\``);
        else if (a.op === 'max') extraSelect.push(`MAX(${col}) AS \`${a.alias}\``);
        else if (a.op === 'min') extraSelect.push(`MIN(${col}) AS \`${a.alias}\``);
        else extraSelect.push(`${a.op.toUpperCase()}(${col}) AS \`${a.alias}\``);
      }
      for (const c of st.postFilters || []) havingConds.push(condSql(c));
    } else if (st.type === 'calc') for (const e of st.exprs || []) extraSelect.push(`(${e.expr.replace(/\{([\u4e00-\u9fa5A-Za-z0-9_.]+)\}/g, '`$1`')}) AS \`${e.alias}\``);
    else if (st.type === 'convert') for (const m of st.mappings || []) extraSelect.push(`${m.func}(${m.args.map((a) => (a.kind === 'const' ? "'" + a.value + "'" : `\`${a.value}\``)).join(',')}) AS \`${m.outAlias || m.alias}\``);
    else if (st.type === 'sort') orderConds = (st.sort || []).map((s) => `\`${s.field}\` ${s.dir === 'desc' ? 'DESC' : 'ASC'}`);
    else if (st.type === 'output') { limit = st.limit; }
    else if (st.type === 'dedup') distinct = true;
  }
  const selCols = cols && cols.length ? cols.map((c) => `\`${c.alias}\``).join(', ') : '*';
  const extra = extraSelect.length ? (', ' + extraSelect.join(', ')) : '';
  lines.push(`SELECT ${distinct ? 'DISTINCT ' : ''}${groupCols && groupCols.length ? '' : selCols}${extra}`);
  lines.push(`FROM ${from}`);
  if (whereConds.length) lines.push(`WHERE ${whereConds.join(' AND ')}`);
  if (groupCols && groupCols.length) lines.push(`GROUP BY ${groupCols.map((c) => `\`${c}\``).join(', ')}`);
  if (havingConds.length) lines.push(`HAVING ${havingConds.join(' AND ')}`);
  if (orderConds.length) lines.push(`ORDER BY ${orderConds.join(', ')}`);
  if (limit) lines.push(`LIMIT ${limit}`);
  return lines.join('\n');
}
function condSql(c) {
  const col = `\`${c.field}\``;
  switch (c.op) {
    case 'eq': return `${col} = '${c.value}'`;
    case 'ne': return `${col} <> '${c.value}'`;
    case 'gt': return `${col} > '${c.value}'`;
    case 'ge': return `${col} >= '${c.value}'`;
    case 'lt': return `${col} < '${c.value}'`;
    case 'le': return `${col} <= '${c.value}'`;
    case 'in': return `${col} IN (${(c.value || []).map((v) => `'${v}'`).join(',')})`;
    case 'contains': return `${col} LIKE '%${c.value}%'`;
    case 'startsWith': return `${col} LIKE '${c.value}%'`;
    case 'isNull': return `${col} IS NULL`;
    case 'notNull': return `${col} IS NOT NULL`;
    case 'between': return `${col} BETWEEN '${c.value[0]}' AND '${c.value[1]}'`;
    default: return `1=1`;
  }
}

module.exports = { runFlow, validate, maskRows, maskValue, OPS, AGGS, evalExpr, applyFilter, aggregate, translateToSql };
