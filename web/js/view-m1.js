/* M1 数据组合分析视图：分析流程设计与多步骤取数(F1-1..F1-4,F1-6)、自定义函数(F1-5)、取数任务(F1-7) */
(function () {
  const U = Util; const esc = U.esc;
  const stepTypes = {
    filter: '条件筛选', aggregate: '聚合计算', calc: '派生计算(四则)',
    convert: '字段转换(函数)', sort: '排序/TopN', dedup: '数据去重', output: '结果输出',
  };
  const OP_LABEL = { eq: '等于', ne: '不等于', gt: '大于', ge: '≥', lt: '小于', le: '≤', in: '∈集合', contains: '包含', startsWith: '开头为', isNull: '为空', notNull: '不为空' };
  const AGG_LABEL = { sum: '求和', avg: '平均值', count: '计数', countd: '去重计数', max: '最大值', min: '最小值' };
  const STATE = { allModels: [], editor: null };

  // ================= 流程列表 =================
  async function analysis(container) {
    const flows = (await API.get('/api/flows')).data;
    STATE.allModels = (await API.get('/api/models')).data;
    const rows = flows.map((f) => {
      const c = f.config || {};
      return `<tr><td><b>${esc(f.flow_name)}</b><div class="mono muted" style="font-size:12px">${esc(f.flow_code)} v${f.version}</div></td>
      <td class="num">${(c.models || []).length}</td><td class="num">${(c.steps || []).length}</td><td>${esc(f.owner)}</td><td>${esc(String(f.updated_at || f.created_at))}</td>
      <td class="row"><button class="btn sm pri" data-act="edit" data-id="${f.id}">打开设计器</button>
      <button class="btn sm" data-act="task" data-id="${f.id}">建任务</button><button class="btn sm danger" data-act="del" data-id="${f.id}">删除</button></td></tr>`;
    }).join('');
    container.innerHTML = Shell.layout({ title: '数据组合分析 · 多步骤取数(F1-1~F1-6)', active: '#/analysis', content: `
      <div class="step-guide"><b>演示建议</b>：点击“⚡套用演示场景”一键生成“主副卡共享流量·流量类投诉高发客户群”4模型多步骤分析 → “打开设计器”逐步骤查看 → “执行并预览” → “保存流程” → “建任务/提交为取数任务”。</div>
      <div class="row" style="margin-bottom:10px">
        <button class="btn pri" data-act="new">+ 新建组合分析</button>
        <button class="btn" data-act="demo">⚡ 套用演示场景</button>
        <button class="btn" data-act="gofuncs">ƒ 自定义函数管理</button>
        <button class="btn" data-act="gotasks">⏱ 取数任务管理</button>
      </div>
      <div class="card"><div class="hd">取数流程列表（配置即资产，可复用）</div><div class="bd">
      <div class="tb-wrap full"><table class="tb"><thead><tr><th>流程名称</th><th>模型数</th><th>步骤数</th><th>创建人</th><th>更新时间</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div></div>` });
    container.querySelector('[data-act=new]').onclick = () => designer(container, null);
    container.querySelector('[data-act=demo]').onclick = async () => designer(container, null, true);
    container.querySelector('[data-act=gofuncs]').onclick = () => funcsView(container);
    container.querySelector('[data-act=gotasks]').onclick = () => tasksView(container);
    container.querySelectorAll('[data-act=edit]').forEach((b) => b.onclick = () => designer(container, flows.find((x) => x.id === Number(b.dataset.id))));
    container.querySelectorAll('[data-act=del]').forEach((b) => b.onclick = async () => { if (confirm('删除该流程？')) { await API.del('/api/flows/' + b.dataset.id); analysis(container); } });
    container.querySelectorAll('[data-act=task]').forEach((b) => b.onclick = () => openTaskModal(container, Number(b.dataset.id)));
  }

  function demoCfg() {
    const mid = (t) => { const m = STATE.allModels.find((x) => x.physical_table === t); return m ? m.id : null; };
    return {
      models: ['sj_customer_profile', 'sj_plan_order', 'sj_cust_complaint', 'sj_cust_traffic_usage'].map(mid).filter(Boolean),
      steps: [
        { type: 'filter', name: '办理主副卡共享流量产品', conditions: [{ field: 'plan_name', op: 'contains', value: '主副卡' }], logic: 'and' },
        { type: 'filter', name: '发生过流量类投诉', conditions: [{ field: 'complaint_type_code', op: 'eq', value: 'FL' }], logic: 'and' },
        { type: 'aggregate', name: '按省份/月份分组汇总', group: ['province_code', 'stat_month'],
          aggs: [{ alias: '超套流量合计', field: 'over_traffic', op: 'sum', decimal: 2 },
            { alias: '月均实际使用流量', field: 'actual_traffic', op: 'avg', decimal: 2 },
            { alias: '流量类投诉量', field: 'id', op: 'count' },
            { alias: '投诉客户数', field: 'cust_id', op: 'countd' }] },
        { type: 'calc', name: '超套占比派生指标', exprs: [{ alias: '超套占比(%)', expr: '({超套流量合计} / {月均实际使用流量}) * 100', decimal: 2, zero: '' }] },
        { type: 'sort', name: '投诉量降序Top20', sort: [{ field: '流量类投诉量', dir: 'desc' }], topN: 20 },
      ],
    };
  }

  function normCfg(c) {
    if (c == null) return { models: [], joins: [], steps: [] };
    if (typeof c === 'string') { try { return JSON.parse(c); } catch (e) { return { models: [], joins: [], steps: [] }; } }
    return JSON.parse(JSON.stringify(c));
  }

  // ================= 设计器 =================
  async function designer(container, flow, isDemo) {
    const models = STATE.allModels.filter((m) => m.status === 'PUBLISHED');
    if (!STATE.allModels.length) { U.warn('请先完成模型注册与发布'); return; }
    let cfg;
    if (isDemo) cfg = demoCfg();
    else cfg = normCfg(flow && flow.config);
    if (isDemo) { cfg.joins = await autoJoins(cfg.models); }
    const ed = STATE.editor = { flowId: flow ? flow.id : null, flowName: (flow ? flow.flow_name : (isDemo ? '主副卡共享流量·流量类投诉高发客户群（演示）' : '')), cfg, models, columns: [], result: null, running: false };
    await refreshColumns(ed);
    renderEditor(container, ed);
  }

  async function autoJoins(ids) {
    if (!ids.length) return [];
    const j = await API.get('/api/recommend?modelIds=' + ids.join(','));
    return j.data.map((r) => ({ type: r.rel_type, left: { model: r.left_model_id, fields: JSON.parse(r.left_fields) }, right: { model: r.right_model_id, fields: JSON.parse(r.right_fields) } }));
  }

  async function refreshColumns(ed) {
    if (!ed.cfg.models || !ed.cfg.models.length) { ed.columns = []; return; }
    try {
      const r = await API.post('/api/analysis/preview', { config: { models: ed.cfg.models, steps: [] }, role: Shell.getMe() ? Shell.getMe().role : 'ANALYST' });
      ed.columns = r.data.columns || [];
    } catch (e) { ed.columns = []; }
  }

  function renderEditor(container, ed) {
    const modelSel = ed.models.map((m) => `<label class="model-chip"><input type="checkbox" data-model="${m.id}" ${ed.cfg.models.includes(m.id) ? 'checked' : ''}> ${esc(m.model_name)}</label>`).join('') || '<span class="empty">暂无已发布模型</span>';
    const joinsHtml = (ed.cfg.joins || []).map((j, i) => {
      const lm = STATE.allModels.find((x) => x.id === j.left.model), rm = STATE.allModels.find((x) => x.id === j.right.model);
      return `<div class="linkline">${i + 1}. ${lm ? lm.model_name : '?'}(${j.left.fields.join('+')}) ——${j.type}→ ${rm ? rm.model_name : '?'}(${j.right.fields.join('+')}) <button class="btn sm danger" data-rmjoin="${i}">移除</button></div>`;
    }).join('') || '<div class="muted">尚未应用关联条件：选择≥2个模型后点击“应用推荐关联”。</div>';
    const stepsHtml = (ed.cfg.steps || []).map((s, i) => {
      const short = stepSummary(s);
      return `<div class="step-node" data-selstep="${i}" title="单击选中（执行到该步）；双击编辑">
        <span class="no">#${i + 1}</span> ${esc(stepTypes[s.type] || s.type)}<br><span class="muted" style="font-size:12px">${esc(short)}</span>
        <div class="row" style="justify-content:center;margin-top:4px">
          <button class="btn sm pri" data-editstep="${i}">编辑</button>
          <button class="btn sm" data-upstep="${i}">↑</button><button class="btn sm" data-downstep="${i}">↓</button><button class="btn sm danger" data-delstep="${i}">删</button>
        </div></div>`;
    }).join('');

    container.innerHTML = Shell.layout({ title: (ed.flowId ? '编辑取数流程' : '新建组合分析') + ' · 多步骤取数', active: '#/analysis', content: `
      <div class="row" style="margin-bottom:8px"><button class="btn" data-act="back">← 流程列表</button>
      <b style="padding:0 6px">已选模型 ${ed.cfg.models.length} 个 · 步骤 ${(ed.cfg.steps || []).length} 个</b></div>

      <div class="card"><div class="hd">① 选择数据模型（≥2个，跨模型组合分析 F1-1）</div><div class="bd">
        <div>${modelSel}</div>
        <div class="row"><button class="btn pri" data-act="applyrel">应用推荐关联（来自F3-4）</button>
        <button class="btn" data-act="refreshcols">刷新字段池</button><span class="muted" style="font-size:12px">字段池 ${ed.columns.length} 个</span></div>
        <div id="joinsBox" style="margin-top:6px">${joinsHtml}</div>
      </div></div>

      <div class="card"><div class="hd">② 流程步骤编排（F1-4 · 支持新增/排序/单步预览）</div><div class="bd">
        <div class="step-bar">${stepsHtml || '<span class="muted">还没有步骤</span>'}</div>
        <div class="row"><button class="btn pri" data-act="addstep">+ 新增步骤</button>
        <button class="btn" data-act="runone">▶ 执行到选中步骤(断点)</button></div>
      </div></div>

      <div class="card"><div class="hd">③ 保存与执行</div><div class="bd">
        <div class="row" style="flex-wrap:wrap;align-items:flex-end">
          <div style="flex:2;min-width:280px">
            <div class="field-group">
              <span class="field-icon">✏️</span>
              <input id="flowName" value="${esc(ed.flowName)}" placeholder="为本次分析起个名字，如：主副卡共享流量·流量类投诉高发客户群">
            </div>
          </div>
          <div class="row" style="margin-left:auto">
            <button class="btn pri" data-act="save">保存流程</button>
            <button class="btn ok" data-act="runall">▶ 执行并预览结果(F1-6)</button>
            <button class="btn" data-act="mktask" ${ed.flowId ? '' : 'disabled'}>提交为取数任务(F1-7)</button>
          </div>
        </div>
        <div id="outPanel"></div>
      </div></div>

      <div class="card"><div class="hd">可用字段池（含自动别名/类型/敏感标记）</div><div class="bd">
        <div class="tb-wrap" style="max-height:260px"><table class="tb"><thead><tr><th>别名(表达式引用)</th><th>中文名</th><th>类型</th><th>敏感</th><th>来源模型</th></tr></thead>
        <tbody>${ed.columns.map((c) => `<tr><td class="mono">${esc(c.alias)}</td><td>${esc(c.cn || '')}</td><td>${esc(c.type)}</td><td>${c.sens ? '<span class="tag red">敏感</span>' : ''}</td><td>${esc(c.modelName || '')}</td></tr>`).join('')}</tbody></table></div>
      </div></div>` });

    container.querySelector('[data-act=back]').onclick = () => analysis(container);
    const chip = container.querySelectorAll('[data-model]');
    chip.forEach((ch) => ch.onchange = async () => {
      const id = Number(ch.dataset.model);
      const i = ed.cfg.models.indexOf(id);
      if (ch.checked && i < 0) ed.cfg.models.push(id);
      if (!ch.checked && i >= 0) ed.cfg.models.splice(i, 1);
      await refreshColumns(ed);
      renderEditor(container, ed);
    });
    container.querySelector('[data-act=applyrel]').onclick = async () => {
      if (!ed.cfg.models.length) { U.warn('请先选择模型'); return; }
      const rels = (await API.get('/api/recommend?modelIds=' + ed.cfg.models.join(','))).data;
      if (!rels.length) { U.err('所选模型间未配置关系，请先到“模型关系管理”配置(F3-4)'); return; }
      ed.cfg.joins = rels.map((r) => ({ type: r.rel_type, left: { model: r.left_model_id, fields: JSON.parse(r.left_fields) }, right: { model: r.right_model_id, fields: JSON.parse(r.right_fields) } }));
      U.ok('已应用 ' + rels.length + ' 条推荐关联');
      renderEditor(container, ed);
    };
    container.querySelector('[data-act=refreshcols]').onclick = async () => { await refreshColumns(ed); renderEditor(container, ed); };
    container.querySelector('[data-act=save]').onclick = async () => {
      const name = (document.getElementById('flowName') && document.getElementById('flowName').value) || ed.flowName || '取数流程';
      if (!(await validateConfig(ed.cfg))) return;
      const saved = (await API.post('/api/flows', { id: ed.flowId, flow_name: name, config: ed.cfg })).data;
      U.ok('流程已保存(#' + saved.id + ')'); ed.flowId = saved.id; ed.flowName = saved.flow_name;
      renderEditor(container, ed);
    };
    container.querySelector('[data-act=runall]').onclick = () => runPreview(container, ed, -1);
    container.querySelector('[data-act=runone]').onclick = () => {
      const sel = container.querySelector('.step-node.act');
      if (!sel) { U.warn('先点击左侧某一步骤节点后再执行断点'); return; }
      runPreview(container, ed, Number(sel.dataset.selstep) + 1); // 包含选中步骤
    };
    container.querySelector('[data-act=mktask]').onclick = () => openTaskModal(container, ed.flowId);
    container.querySelector('[data-act=addstep]').onclick = () => stepModal(container, ed, null);
    container.querySelectorAll('[data-delstep]').forEach((b) => b.onclick = () => { ed.cfg.steps.splice(Number(b.dataset.delstep), 1); renderEditor(container, ed); });
    container.querySelectorAll('[data-upstep]').forEach((b) => b.onclick = () => moveStep(ed, Number(b.dataset.upstep), -1, container));
    container.querySelectorAll('[data-downstep]').forEach((b) => b.onclick = () => moveStep(ed, Number(b.dataset.downstep), 1, container));
    container.querySelectorAll('[data-rmjoin]').forEach((b) => b.onclick = () => { ed.cfg.joins.splice(Number(b.dataset.rmjoin), 1); renderEditor(container, ed); });
    container.querySelectorAll('[data-selstep]').forEach((b) => b.onclick = () => {
      container.querySelectorAll('.step-node').forEach((x) => x.classList.remove('act'));
      b.classList.add('act');
    });
    // 编辑已添加的步骤：节点上的“编辑”按钮 / 双击节点
    container.querySelectorAll('[data-editstep]').forEach((b) => b.onclick = () => stepModal(container, ed, Number(b.dataset.editstep)));
    container.querySelectorAll('.step-node').forEach((node) => node.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      stepModal(container, ed, Number(node.dataset.selstep));
    }));
  }

  function moveStep(ed, i, dir, container) {
    const j = i + dir; if (j < 0 || j >= ed.cfg.steps.length) return;
    const t = ed.cfg.steps[i]; ed.cfg.steps[i] = ed.cfg.steps[j]; ed.cfg.steps[j] = t;
    renderEditor(container, ed);
  }
  function stepSummary(s) {
    if (s.type === 'filter') return '条件 ' + (s.conditions || []).length + ' 个';
    if (s.type === 'aggregate') return ((s.group || []).join('+') || '全表') + ' · ' + (s.aggs || []).map((a) => a.alias).join(',');
    if (s.type === 'calc') return (s.exprs || []).map((e) => e.alias).join(',');
    if (s.type === 'convert') return (s.mappings || []).map((m) => m.func + '→' + m.outAlias).join(',');
    if (s.type === 'sort') return (s.sort || []).map((x) => x.field).join(',') + (s.topN ? ' Top' + s.topN : '');
    if (s.type === 'dedup') return (s.fields || []).join(',');
    if (s.type === 'output') return s.fields ? 'limit=' + (s.limit || '-') : '';
    return '';
  }

  async function validateConfig(cfg) {
    try {
      const r = await API.post('/api/analysis/validate', { config: cfg });
      if (r.data && r.data.issues.length) { U.err('配置校验未通过：\n' + r.data.issues.join('\n')); return false; }
      return true;
    } catch (e) { U.err(e.message); return false; }
  }

  async function runPreview(container, ed, until) {
    if (!ed.cfg.models || ed.cfg.models.length < 2) { U.err('请选择≥2个模型'); return; }
    if (!(ed.cfg.joins || []).length) { U.warn('请先应用推荐关联'); return; }
    ed.running = true;
    const name = document.getElementById('flowName') ? document.getElementById('flowName').value : '';
    try {
      const r = await API.post('/api/analysis/preview', { config: ed.cfg, until, role: Shell.getMe() ? Shell.getMe().role : 'ANALYST' });
      ed.result = r.data;
      if (name && ed.flowId) { try { await API.post('/api/flows', { id: ed.flowId, flow_name: name, config: ed.cfg }); } catch (e) {} }
      U.ok('执行完成：' + r.data.total + ' 行 · ' + r.data.duration + 'ms');
    } catch (e) { U.err(e.message); } finally { ed.running = false; renderEditor(container, ed); }
    const out = document.getElementById('outPanel');
    if (out && ed.result) renderResult(out, ed.result);
  }

  function renderResult(out, d) {
    const cols = d.columns || []; const rows = d.rows || [];
    const th = cols.map((c) => `<th>${esc(c.cn || c.alias)}${c.sens ? '<span class="tag red">敏</span>' : ''}</th>`).join('');
    const trs = rows.slice(0, 150).map((r) => `<tr>${cols.map((c) => `<td class="${c.type === 'NUMBER' ? 'num' : ''}">${esc(r[c.alias])}</td>`).join('')}</tr>`).join('');
    out.innerHTML = `<div class="card"><div class="hd">结果预览(F1-6) · 共 ${d.total} 行 · 当前角色脱敏
      <span><button class="btn sm" data-preview="tbl">结果表</button><button class="btn sm" data-preview="sql">等价SQL</button><button class="btn sm" data-preview="log">执行日志</button></span></div>
      <div class="bd" id="pvBox"><div class="tb-wrap" style="max-height:340px"><table class="tb"><thead><tr>${th}</tr></thead><tbody>${trs || '<tr><td class="empty">结果为空</td></tr>'}</tbody></table></div></div></div>`;
    const pv = out.querySelector('#pvBox');
    out.querySelector('[data-preview=tbl]').onclick = () => { pv.innerHTML = `<div class="tb-wrap" style="max-height:340px"><table class="tb"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`; };
    out.querySelector('[data-preview=sql]').onclick = () => { pv.innerHTML = `<div class="sqlbox">${esc(d.sql || '')}</div>`; };
    out.querySelector('[data-preview=log]').onclick = () => { pv.innerHTML = `<div class="flow-logs">${esc((d.logs || []).join('\n'))}</div>`; };
  }

  // ================= 步骤编辑弹窗 =================
  async function stepModal(container, ed, idx) {
    const isEdit = idx !== null && idx !== undefined;
    const steps = ed.cfg.steps;
    const init = isEdit ? steps[idx] : { type: 'filter' };
    const cols = ed.columns;
    if (!cols.length) { U.warn('请先选择≥2个模型并应用推荐关联，获得可用字段池'); return; }
    const funcs = (await API.get('/api/funcs')).data.filter((f) => f.status === 'PUBLISHED');
    let kind = init.type;

    // —— 小工具：定宽控件容器 + 下拉/选项 ——
    const ctl = (w, inner) => `<span class="ctl" style="width:${w};display:inline-block">${inner}</span>`;
    const colOptsSel = (selVal) => cols.map((c) => `<option value="${esc(c.alias)}" ${c.alias === selVal ? 'selected' : ''}>${esc(c.alias)}｜${esc(c.cn)}${c.sens ? '·敏' : ''}</option>`).join('');
    const colSel = (id, selVal) => `<select id="${id}">${colOptsSel(selVal)}</select>`;
    const opOpts = (cur) => Object.entries(OP_LABEL).map(([k, v]) => `<option value="${k}" ${(cur || 'eq') === k ? 'selected' : ''}>${v}</option>`).join('');
    const aggOpts = (cur) => Object.keys(AGG_LABEL).map((o) => `<option value="${o}" ${o === (cur || 'sum') ? 'selected' : ''}>${AGG_LABEL[o]}</option>`).join('');
    const funcOpts = (cur) => funcs.map((f) => `<option value="${esc(f.func_code)}" ${cur === f.func_code ? 'selected' : ''}>${esc(f.func_name)}(${esc(f.func_code)})</option>`).join('');

    // 行模板：保持 collectStep 依赖的控件 id（f_i/o_i/v_i、al_i/af_i/ao_i/ad_i、al_i/ce_i、fn_i/fa_i/fo_i、sf_i/sd_i）
    const rowFilter = (i, c) => {
      const valInit = c.value == null ? '' : (Array.isArray(c.value) ? c.value.join(',') : String(c.value));
      const noVal = ['isNull', 'notNull'].includes(c.op);
      return `<div class="crow row filterrow" data-i="${i}" style="flex-wrap:wrap;align-items:center">
        ${ctl('190px', `<select id="f_${i}" class="fld">${colOptsSel(c.field)}</select>`)}
        ${ctl('112px', `<select id="o_${i}" class="opsel">${opOpts(c.op)}</select>`)}
        <span class="fvalwrap" style="${noVal ? 'display:none' : ''}">
          <input id="v_${i}" class="fval" value="${esc(valInit)}" list="dl_${i}" placeholder="点选候选值或输入…">
          <datalist id="dl_${i}"></datalist>
        </span>
        <button class="btn sm danger" data-rmrow="crow" data-i="${i}">删</button></div>`;
    };
    const rowAgg = (i, a) => `<div class="arow aggline" data-i="${i}">
      <span class="aliasbox"><b>名</b><input id="al_${i}" value="${esc(a.alias || '')}" placeholder="结果字段名"></span>
      <select id="af_${i}">${colOptsSel(a.field)}</select>
      <select id="ao_${i}">${aggOpts(a.op)}</select>
      <input id="ad_${i}" type="number" value="${a.decimal != null ? a.decimal : 2}" title="小数位(0-8)" min="0" max="8">
      <button class="btn sm danger" data-rmrow="arow" data-i="${i}">删</button></div>`;
    const rowCalc = (i, e) => `<div class="crow row" data-i="${i}" style="flex-wrap:wrap;align-items:center">
      ${ctl('170px', `<input id="al_${i}" value="${esc(e.alias || '')}" placeholder="派生字段名">`)}
      <span style="flex:1;min-width:260px"><input id="ce_${i}" value="${esc(e.expr || '')}" placeholder="表达式，如 ({a}-{b})/{b}*100"></span>
      <button class="btn sm danger" data-rmrow="crow" data-i="${i}">删</button></div>`;
    const rowMap = (i, m) => `<div class="crow row" data-i="${i}" style="flex-wrap:wrap;align-items:center">
      ${ctl('200px', `<select id="fn_${i}">${funcOpts(m && m.func)}</select>`)}
      <span style="flex:1;min-width:200px">${colSel('fa_' + i, m && m.args && m.args[0] ? m.args[0].value : undefined)}</span>
      ${ctl('150px', `<input id="fo_${i}" value="${esc((m && m.outAlias) || '')}" placeholder="输出列名">`)}
      <button class="btn sm danger" data-rmrow="crow" data-i="${i}">删</button></div>`;
    const rowSort = (i, s) => `<div class="crow row" data-i="${i}" style="flex-wrap:wrap;align-items:center">
      <span style="flex:1;min-width:220px">${colSel('sf_' + i, s.field)}</span>
      ${ctl('100px', `<select id="sd_${i}"><option value="desc" ${(!s || s.dir === 'desc') ? 'selected' : ''}>降序</option><option value="asc" ${s && s.dir === 'asc' ? 'selected' : ''}>升序</option></select>`)}
      <button class="btn sm danger" data-rmrow="crow" data-i="${i}">删</button></div>`;

    function bodyFor(t, cur) {
      const group = cur.group || [];
      const curAg = cur.aggs || [];
      if (t === 'filter') return `<div id="rowsBox">${(cur.conditions || []).map((c, i) => rowFilter(i, c)).join('')}</div>
        <button class="btn sm" id="addRow">+ 条件</button><span class="muted" style="font-size:12px">等值/包含等条件可直接在值框下拉点选该列已有值（如“地市→郑州市”）；多值用逗号分隔并选择“∈集合”；“为空/不为空”无需填值。多条件按 AND 组合。</span>`;
      if (t === 'aggregate') return `<label>分组维度（点击复选框选择，可多选；不选=全表汇总）</label>
        <div id="grpSel" class="chklist">${cols.map((c) => `<label class="chk"><input type="checkbox" value="${esc(c.alias)}" ${group.includes(c.alias) ? 'checked' : ''}><span>${esc(c.alias)}｜${esc(c.cn)}</span></label>`).join('')}</div>
        <label>聚合字段（求和/平均值/计数…）</label><div id="rowsBox">${curAg.map((a, i) => rowAgg(i, a)).join('')}</div><button class="btn sm" id="addRow">+ 聚合字段</button>
        <p class="muted" style="font-size:12px">对非数值字段配置求和/平均值时，系统将给出明确提示（验收标准）。</p>`;
      if (t === 'calc') return `<label>四则运算派生字段</label><div id="rowsBox">${(cur.exprs || []).map((e, i) => rowCalc(i, e)).join('')}</div>
        <button class="btn sm" id="addRow">+ 派生字段</button>
        <p class="muted" style="font-size:12px">字段用 <b>{别名}</b> 引用，支持 + - * / 与括号；示例：({over_traffic} - {package_traffic}) / {package_traffic} * 100<br>除数为0时结果为空不中断。</p>`;
      if (t === 'convert') return `<label>字段转换（调用自定义函数 F1-5）</label><div id="rowsBox">${(cur.mappings || []).map((m, i) => rowMap(i, m)).join('')}</div><button class="btn sm" id="addRow">+ 转换</button>
        <p class="muted" style="font-size:12px">如 PROVINCE_NAME(省份编码)→省份名称。输出列名=新增列。</p>`;
      if (t === 'sort') return `<label>排序字段</label><div id="rowsBox">${(cur.sort || []).map((s, i) => rowSort(i, s)).join('')}</div><button class="btn sm" id="addRow">+ 排序</button>
        <label>TopN(可选)</label><input id="topN" type="number" value="${cur.topN || ''}" style="max-width:120px">`;
      if (t === 'dedup') return `<label>按字段去重(可多选，空=整行去重)</label><select id="grpSel" multiple style="height:130px">${cols.map((c) => `<option value="${esc(c.alias)}" ${(cur.fields || []).includes(c.alias) ? 'selected' : ''}>${esc(c.alias)}｜${esc(c.cn)}</option>`).join('')}</select>`;
      if (t === 'output') return `<label>输出字段(可多选)</label><select id="grpSel" multiple style="height:140px">${cols.map((c) => `<option value="${esc(c.alias)}">${esc(c.alias)}｜${esc(c.cn)}</option>`).join('')}</select>
        <label>返回行数限制(空=不限)</label><input id="outLimit" type="number" value="${cur.limit || ''}" style="max-width:120px">`;
      return '';
    }

    let box;
    U.modal((isEdit ? '编辑步骤' : '新增步骤') + ' · ' + stepTypes[kind], `
      <div class="row" style="margin-bottom:6px">步骤类型
        <select id="stepType">${Object.entries(stepTypes).map(([k, v]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${v}</option>`).join('')}</select>
      </div>
      <div id="body">${bodyFor(kind, init)}</div>
      <p class="muted" style="font-size:12px">引擎按步骤顺序执行：前一步骤输出作为后一步骤输入，支持分步执行与中间结果预览。</p>`, { wide: true, okText: isEdit ? '保存步骤' : '添加步骤', onOk: () => {
      const t = document.getElementById('stepType').value;
      const s = collectStep(t);
      if (!s) throw new Error('请完整配置该步骤');
      if (isEdit) steps[idx] = s; else steps.push(s);
      renderEditor(container, ed);
      return true;
    } });

    const typeSel = document.getElementById('stepType');
    typeSel.onchange = () => { kind = typeSel.value; const bb = document.getElementById('body'); bb.innerHTML = bodyFor(kind, {}); wireRows(); };

    function nextRowIdx() {
      let mx = -1;
      document.querySelectorAll('#rowsBox .crow, #rowsBox .arow').forEach((r) => { const v = Number(r.dataset.i); if (!Number.isNaN(v) && v > mx) mx = v; });
      return mx + 1;
    }

    // 等值/包含条件的候选值：从“关联后明细”中取该列出现的值，供点选（如地市）
    async function loadFilterCandidates(row) {
      const i = row.dataset.i;
      const fsel = row.querySelector('#f_' + i);
      const dl = document.getElementById('dl_' + i);
      const hint = row.querySelector('.fhint');
      if (!fsel || !dl) return;
      dl.innerHTML = '';
      const alias = fsel.value;
      if (!alias) return;
      try {
        const baseModels = ed.cfg.models || [];
        if (baseModels.length < 2) return;
        const r = await API.post('/api/analysis/preview', { config: { models: baseModels, joins: ed.cfg.joins || [], steps: [] } });
        const seen = new Set(); const vals = [];
        for (const x of (r.data.rows || [])) {
          const v = x[alias];
          if (v == null || v === '') continue;
          const key = String(v);
          if (seen.has(key)) continue;
          seen.add(key); vals.push(key);
          if (vals.length >= 60) break;
        }
        dl.innerHTML = vals.map((x) => `<option value="${esc(x)}">`).join('');
        if (hint) hint.textContent = vals.length ? `可点选该列候选值（${vals.length} 个）或手动输入` : '当前列暂无候选值，可手动输入';
      } catch (e) { /* 候选加载失败时仍允许手动输入 */ }
    }

    function wireFilterRow(row) {
      const i = row.dataset.i;
      const osel = row.querySelector('#o_' + i);
      const fsel = row.querySelector('#f_' + i);
      const wrap = row.querySelector('.fvalwrap');
      const toggle = () => { if (osel && wrap) wrap.style.display = ['isNull', 'notNull'].includes(osel.value) ? 'none' : ''; };
      if (osel) osel.onchange = toggle;
      if (fsel) fsel.onchange = () => loadFilterCandidates(row);
      toggle();
      loadFilterCandidates(row);
    }

    function wireRows() {
      const rowsBox = document.getElementById('rowsBox');
      const addBtn = document.getElementById('addRow');
      if (!rowsBox) return;
      // 初始行
      rowsBox.querySelectorAll('.crow, .arow').forEach((row) => { if (row.classList.contains('filterrow')) wireFilterRow(row); });
      rowsBox.addEventListener('click', (e) => { const b = e.target.closest('[data-rmrow]'); if (b) b.closest('.row').remove(); });
      if (addBtn) addBtn.onclick = () => {
        const n = nextRowIdx();
        if (kind === 'filter') { rowsBox.insertAdjacentHTML('beforeend', rowFilter(n, {})); wireFilterRow(rowsBox.lastElementChild); }
        else if (kind === 'aggregate') rowsBox.insertAdjacentHTML('beforeend', rowAgg(n, {}));
        else if (kind === 'calc') rowsBox.insertAdjacentHTML('beforeend', rowCalc(n, {}));
        else if (kind === 'convert') rowsBox.insertAdjacentHTML('beforeend', rowMap(n, {}));
        else if (kind === 'sort') rowsBox.insertAdjacentHTML('beforeend', rowSort(n, {}));
      };
    }
    wireRows();

    function collectStep(t) {
      const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
      if (t === 'filter') {
        const conditions = [...document.querySelectorAll('#rowsBox .crow')].map((r) => {
          const i = r.dataset.i;
          const op = val('o_' + i) || 'eq';
          const raw = val('v_' + i);
          const value = op === 'in' ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
          return { field: val('f_' + i), op, value };
        }).filter((c) => c.field);
        if (!conditions.length) return null;
        if (conditions.some((c) => !['isNull', 'notNull'].includes(c.op) && (c.value == null || c.value === '' || (Array.isArray(c.value) && !c.value.length)))) { U.err('存在未填“值”的筛选条件，请补充后保存'); return null; }
        return { type: 'filter', name: '条件筛选', conditions, logic: 'and' };
      }
      if (t === 'aggregate') {
        const grpEl = document.getElementById('grpSel');
        const group = grpEl && grpEl.classList.contains('chklist')
          ? [...grpEl.querySelectorAll('input:checked')].map((i) => i.value)
          : [...(grpEl ? grpEl.selectedOptions : [])].map((o) => o.value);
        const aggs = [...document.querySelectorAll('#rowsBox .arow')].map((r) => {
          const i = r.dataset.i;
          return { alias: val('al_' + i), op: val('ao_' + i), field: val('af_' + i), decimal: Number(val('ad_' + i) || 2) };
        }).filter((a) => a.alias && a.field);
        if (!aggs.length) return null;
        return { type: 'aggregate', name: '聚合计算', group, aggs };
      }
      if (t === 'calc') {
        const exprs = [...document.querySelectorAll('#rowsBox .crow')].map((r) => { const i = r.dataset.i; return { alias: val('al_' + i), expr: val('ce_' + i), decimal: 2, zero: '' }; }).filter((e) => e.alias && e.expr);
        if (!exprs.length) return null;
        return { type: 'calc', name: '派生计算', exprs };
      }
      if (t === 'convert') {
        const mappings = [...document.querySelectorAll('#rowsBox .crow')].map((r) => { const i = r.dataset.i; return { func: val('fn_' + i), args: [{ kind: 'field', value: val('fa_' + i) }], outAlias: val('fo_' + i) }; }).filter((m) => m.func && m.outAlias);
        if (!mappings.length) return null;
        return { type: 'convert', name: '字段转换', mappings };
      }
      if (t === 'sort') {
        const sort = [...document.querySelectorAll('#rowsBox .crow')].map((r) => { const i = r.dataset.i; return { field: val('sf_' + i), dir: val('sd_' + i) || 'desc' }; }).filter((s) => s.field);
        if (!sort.length) return null;
        return { type: 'sort', name: '排序与TopN', sort, topN: Number(val('topN')) || 0 };
      }
      if (t === 'dedup') return { type: 'dedup', name: '数据去重', fields: [...(document.getElementById('grpSel') ? document.getElementById('grpSel').selectedOptions : [])].map((o) => o.value) };
      if (t === 'output') {
        const fields = [...(document.getElementById('grpSel') ? document.getElementById('grpSel').selectedOptions : [])].map((o) => o.value);
        return { type: 'output', name: '结果输出', fields, limit: Number(val('outLimit')) || 0 };
      }
      return { type: t };
    }
  }

  // ================= 函数管理 F1-5 =================
  async function funcsView(container) {
    const funcs = (await API.get('/api/funcs')).data;
    const rows = funcs.map((f) => `<tr><td><b>${esc(f.func_name)}</b><div class="mono muted">${esc(f.func_code)} v${f.version}</div></td>
      <td>${esc(f.category)}</td><td>${esc((JSON.parse(f.in_params || '[]') || []).map((p) => p.name + ':' + p.type).join(', ') || '-')}</td>
      <td>${esc(f.return_type)}</td><td>${f.status === 'PUBLISHED' ? '<span class="badge ok">已发布</span>' : f.status === 'OFF' ? '<span class="badge">已下架</span>' : '<span class="badge warn">草稿</span>'}</td>
      <td class="row"><button class="btn sm pri" data-act="edit" data-id="${f.id}">测试/编辑</button>
      <button class="btn sm" data-act="pub" data-id="${f.id}" ${f.status === 'PUBLISHED' ? 'disabled' : ''}>发布</button>
      <button class="btn sm" data-act="off" data-id="${f.id}" ${f.status !== 'PUBLISHED' ? 'disabled' : ''}>下架</button>
      <button class="btn sm" data-act="usage" data-id="${f.id}">影响分析</button></td></tr>`).join('');
    container.innerHTML = Shell.layout({ title: '数据组合分析 · 自定义数据处理函数(F1-5)', active: '#/funcs', content: `
      <div class="step-guide"><b>说明</b>：函数支持注册/在线测试/审核发布；发布后在流程“字段转换”步骤中调用（如 省份编码转名称、月份转季度、号码归属识别）。函数在白名单校验后在受限沙箱执行，变更全量审计。</div>
      <div class="row" style="margin-bottom:10px"><button class="btn" data-act="back">← 返回组合分析</button><button class="btn pri" data-act="new">+ 新建函数</button></div>
      <div class="card"><div class="hd">函数库</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr><th>函数/编码</th><th>分类</th><th>入参</th><th>返回</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>` });
    container.querySelector('[data-act=back]').onclick = () => analysis(container);
    container.querySelector('[data-act=new]').onclick = () => funcModal(container, null);
    container.querySelectorAll('[data-act=edit]').forEach((b) => b.onclick = () => funcModal(container, funcs.find((f) => f.id === Number(b.dataset.id))));
    container.querySelectorAll('[data-act=pub]').forEach((b) => b.onclick = async () => { await API.post('/api/funcs/' + b.dataset.id + '/status', { status: 'PUBLISHED' }); U.ok('函数已发布'); funcsView(container); });
    container.querySelectorAll('[data-act=off]').forEach((b) => b.onclick = async () => { await API.post('/api/funcs/' + b.dataset.id + '/status', { status: 'OFF' }); U.ok('已下架'); funcsView(container); });
    container.querySelectorAll('[data-act=usage]').forEach((b) => b.onclick = async () => {
      const u = (await API.get('/api/funcs/' + b.dataset.id + '/usage')).data;
      U.modal('影响分析', `<p>该函数被 <b>${u.flows.length}</b> 个取数流程引用：</p><ul>${u.flows.map((f) => `<li>${esc(f.flow_name)}（${esc(f.status)}）</li>`).join('') || '<li>暂无引用</li>'}</ul>`);
    });
  }

  async function funcModal(container, f) {
    const isNew = !f;
    const d = f || { func_code: '', func_name: '', category: '', func_desc: '', in_params: [], body: '', return_type: 'STRING' };
    const code = prompt('函数编码（唯一，如 BIZ_NAME）：', d.func_code || '');
    if (code === null) return;
    const name = prompt('函数名称：', d.func_name || '');
    const cat = prompt('分类（码表转换/日期加工/号码识别等）：', d.category || '') || '';
    const body = prompt('实现逻辑（沙箱JS；入参变量名=下方参数名）：\n示例：const m=CODE_MAP.PROVINCE; return m[String(code)]||code;\n\n输入函数体（单函数，支持return）：', d.body || '') || '';
    if (!code || !name) { U.warn('编码与名称必填'); return; }
    const inDesc = prompt('入参定义，格式：参数名1:STRING, 参数名2:NUMBER（逗号分隔）：', (d.in_params || []).map((p) => p.name + ':' + p.type).join(',') || 'code:STRING');
    const in_params = (inDesc || '').split(',').map((s) => { const [n, t] = s.trim().split(':'); return n ? { name: n.trim(), type: (t || 'STRING').trim().toUpperCase(), required: true } : null; }).filter(Boolean);
    const testArgs = JSON.parse(prompt('在线测试参数JSON数组，如 ["410000"]（空则跳过）', '[]') || '[]');
    const payload = { func_code: code, func_name: name, category: cat, func_desc: prompt('业务说明：', d.func_desc || '') || '', return_type: prompt('返回类型 STRING/NUMBER', d.return_type || 'STRING') || 'STRING', in_params, body };
    try {
      if (isNew) { const r = await API.post('/api/funcs', payload); if (testArgs && testArgs.length) { const t = await API.post('/api/funcs/' + r.data.id + '/test', { args: testArgs }); U.ok('注册成功。在线测试：' + (t.data.ok ? JSON.stringify(t.data.result) : '失败 ' + t.data.error)); } else U.ok('已注册为草稿'); }
      else { await API.put('/api/funcs/' + f.id, payload); if (testArgs && testArgs.length) { const t = await API.post('/api/funcs/' + f.id + '/test', { args: testArgs }); U.ok('已保存。在线测试：' + (t.data.ok ? JSON.stringify(t.data.result) : '失败 ' + t.data.error)); } else U.ok('已保存'); }
      funcsView(container);
    } catch (e) { U.err(e.message); }
  }

  // ================= 取数任务 F1-7 =================
  async function tasksView(container) {
    const tasks = (await API.get('/api/tasks')).data;
    const st = { PENDING: ['badge warn', '待执行'], RUNNING: ['badge', '执行中'], SUCCESS: ['badge ok', '执行成功'], FAILED: ['badge err', '执行失败'], TERMINATED: ['badge', '已终止'] };
    const rows = tasks.map((t) => { const b = st[t.status] || ['badge', t.status];
      return `<tr><td><b>${esc(t.task_name)}</b><div class="mono muted" style="font-size:12px">${esc(t.task_code)}</div></td><td>${esc(t.flow_name || '-')}</td>
      <td>${t.exec_type === 'ONCE' ? '即时' : (esc(t.cron_desc || t.cron) + '')}</td><td><span class="${b[0]}">${b[1]}</span></td>
      <td>${esc(t.owner)}</td><td class="num">${t.last_run ? t.last_run.row_count : '-'}</td>
      <td class="mono" style="font-size:12px">${t.next_run_at ? '下次:' + esc(t.next_run_at) : (t.last_run ? esc(String(t.last_run.finished_at || '').slice(5, 19)) : '-')}</td>
      <td class="row"><button class="btn sm pri" data-act="run" data-id="${t.id}" ${t.status === 'RUNNING' ? 'disabled' : ''}>执行</button>
      <button class="btn sm" data-act="detail" data-id="${t.id}">记录</button>
      <button class="btn sm" data-act="term" data-id="${t.id}" ${t.status !== 'RUNNING' && t.status !== 'PENDING' ? 'disabled' : ''}>终止</button>
      <button class="btn sm danger" data-act="del" data-id="${t.id}">删除</button></td></tr>`; }).join('');
    container.innerHTML = Shell.layout({ title: '数据组合分析 · 取数任务管理(F1-7)', active: '#/tasks', content: `
      <div class="step-guide"><b>演示</b>：提交即时任务观察状态流转（待执行→执行中→执行成功）；提交周期任务（如每5秒）由调度器自动触发并观察新增运行记录；失败任务可看日志；结果集7天自动清理、清理留痕。</div>
      <div class="row" style="margin-bottom:10px"><button class="btn" data-act="back">← 返回组合分析</button><button class="btn pri" data-act="new">+ 新建任务</button>
      <button class="btn" data-act="refresh">刷新</button></div>
      <div class="card"><div class="hd">任务列表</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr>
        <th>任务</th><th>取数流程</th><th>执行方式</th><th>状态</th><th>创建人</th><th>最近行数</th><th>最近/下次时间</th><th>操作</th>
      </tr></thead><tbody>${rows}</tbody></table></div></div></div>` });
    const back = container.querySelector('[data-act=back]'); if (back) back.onclick = () => analysis(container);
    container.querySelector('[data-act=new]').onclick = () => openTaskModal(container);
    container.querySelector('[data-act=refresh]').onclick = () => tasksView(container);
    container.querySelectorAll('[data-act=run]').forEach((b) => b.onclick = async () => { const r = await API.post('/api/tasks/' + b.dataset.id + '/run'); if (r.data.ok) U.ok('执行成功'); else U.warn('执行失败：' + (r.data.error || '')); tasksView(container); });
    container.querySelectorAll('[data-act=term]').forEach((b) => b.onclick = async () => { await API.post('/api/tasks/' + b.dataset.id + '/terminate'); U.ok('已终止'); tasksView(container); });
    container.querySelectorAll('[data-act=del]').forEach((b) => b.onclick = async () => { if (confirm('删除任务及其记录？')) { await API.del('/api/tasks/' + b.dataset.id); tasksView(container); } });
    container.querySelectorAll('[data-act=detail]').forEach((b) => b.onclick = () => runDetail(container, Number(b.dataset.id)));
    setTimeout(() => Shell.refreshBell(), 500);
  }

  async function openTaskModal(container, flowId) {
    const flows = (await API.get('/api/flows')).data;
    if (!flows.length) { U.warn('请先保存一个取数流程'); return; }
    const presets = [['*/5 * * * * *', '每5秒(演示，适合现场演示自动触发)'], ['0 * * * * *', '每分钟'], ['0 0 * * * *', '每小时'], ['0 0 9 * * *', '每日09:00']];
    U.modal('提交取数任务(F1-7)', `
      <label>任务名称</label><input id="tk_name" placeholder="任务名称">
      <div class="grid2"><div><label>取数流程</label><select id="tk_flow">${flows.map((f) => `<option value="${f.id}" ${flowId === f.id ? 'selected' : ''}>${esc(f.flow_name)}</option>`).join('')}</select></div>
      <div><label>执行方式</label><select id="tk_type"><option value="ONCE">即时执行</option><option value="CRON">周期执行(Cron)</option></select></div></div>
      <div id="cronBox" style="display:none">
        <div class="grid2"><div><label>预设周期</label><select id="tk_preset">${presets.map((p) => `<option value="${p[0]}">${p[1]}</option>`).join('')}</select></div>
        <div><label>Cron(秒 分 时 日 月 周)</label><input id="tk_cron" value="*/5 * * * * *"></div></div>
        <p class="muted" style="font-size:12px">提交后系统自动计算“下次执行时间”，调度器将按时自动触发并在每次运行后更新。</p></div>
      <label>失败自动重试次数</label><input id="tk_retry" type="number" value="1" min="0" max="3" style="max-width:120px">`, { onOk: async () => {
      const type = document.getElementById('tk_type').value;
      const payload = { flow_id: Number(document.getElementById('tk_flow').value), task_name: document.getElementById('tk_name').value || '取数任务', exec_type: type, retry: Number(document.getElementById('tk_retry').value) || 0, cron: type === 'CRON' ? document.getElementById('tk_cron').value : '', cron_desc: type === 'CRON' ? document.getElementById('tk_preset').selectedOptions[0].textContent : '', schedule_to: '2099-12-31' };
      const r = await API.post('/api/tasks', payload);
      U.ok('任务已创建：' + r.data.status + (r.data.next_run_at ? '，下次执行 ' + r.data.next_run_at : ''));
      tasksView(container);
    } });
    document.getElementById('tk_type').onchange = (e) => { document.getElementById('cronBox').style.display = e.target.value === 'CRON' ? 'block' : 'none'; };
    document.getElementById('tk_preset').onchange = (e) => { document.getElementById('tk_cron').value = e.target.value; };
  }

  async function runDetail(container, taskId) {
    const t = (await API.get('/api/tasks/' + taskId)).data;
    const runs = (t.runs || []).map((r) => `<tr><td>#${r.run_no}</td><td>${r.status}</td><td class="num">${r.row_count}</td><td class="num">${r.duration_ms}ms</td><td>${esc(String(r.finished_at || ''))}</td>
      <td style="max-width:260px">${r.status === 'FAILED' ? '<span class="badge err">' + esc(String(r.error || '').slice(0, 160)) + '</span>' : ''}</td>
      <td class="row"><button class="btn sm pri" data-viewrun="${r.id}" ${r.status !== 'SUCCESS' ? 'disabled' : ''}>结果</button>
      <a class="btn sm" href="/api/runs/${r.id}/export" download>导出CSV</a></td></tr>`).join('');
    container.innerHTML = Shell.layout({ title: '任务运行记录 · ' + esc(t.task_name), active: '#/tasks', content: `
      <div class="row" style="margin-bottom:8px"><button class="btn" data-act="back">← 任务列表</button>
      <span class="pill">${esc(t.task_code)}</span><span class="pill">状态 ${esc(t.status)}</span><span class="pill">${t.exec_type === 'CRON' ? 'Cron: ' + esc(t.cron) : '即时执行'}</span></div>
      <div class="card"><div class="hd">历史运行（有效期7天，过期自动清理）</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr><th>运行</th><th>状态</th><th>行数</th><th>耗时</th><th>完成时间</th><th>错误</th><th>操作</th></tr></thead><tbody>${runs}</tbody></table></div></div></div>
      <div id="runView"></div>` });
    container.querySelector('[data-act=back]').onclick = () => tasksView(container);
    container.querySelectorAll('[data-viewrun]').forEach((b) => b.onclick = async () => {
      const run = (await API.get('/api/runs/' + b.dataset.viewrun)).data;
      const cols = run.columns || []; const rows = run.rows || [];
      const th = cols.map((c) => `<th>${esc(c.cn || c.alias)}${c.sens ? '<span class="tag red">敏</span>' : ''}</th>`).join('');
      const trs = rows.slice(0, 200).map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c.alias])}</td>`).join('')}</tr>`).join('');
      document.getElementById('runView').innerHTML = `<div class="card"><div class="hd">结果集（按当前角色脱敏）· ${run.row_count} 行 <button class="btn sm" id="showsql">查看SQL</button></div>
        <div class="bd"><div class="tb-wrap" style="max-height:420px"><table class="tb"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>
        <div id="sqlbox" class="sqlbox" style="display:none">${esc(run.sql || '')}</div></div></div>`;
      const sb = document.getElementById('showsql'); if (sb) sb.onclick = () => { const b2 = document.getElementById('sqlbox'); b2.style.display = b2.style.display === 'none' ? 'block' : 'none'; };
    });
  }

  window.Views = window.Views || {}; window.Views.m1 = { analysis, funcsView, tasksView };
})();
