/* M3 分析模型管理视图：模型注册/元数据/脱敏配置/数据预览/关系 */
(function () {
  const U = Util; const esc = U.esc;
  let M = null; // 当前模型
  const STATUS_BADGE = { DRAFT: ['badge warn', '草稿'], PUBLISHED: ['badge ok', '已发布'], STOPPED: ['badge', '已停用'], OFFLINE: ['badge gray', '已下线'] };

  async function apiModels() { return (await API.get('/api/models')).data; }
  async function apiModel(id) { return (await API.get('/api/models/' + id)).data; }

  async function list(container) {
    M = null;
    const models = await apiModels();
    const meta = (await API.get('/api/meta/tables')).data;
    const rows = models.map((m) => {
      const b = STATUS_BADGE[m.status] || ['badge', m.status];
      return `<tr>
        <td><b>${esc(m.model_name)}</b><div class="muted" style="font-size:12px">${esc(m.physical_table)}</div></td>
        <td>${esc(m.model_code)}</td><td>${esc(m.topic)}</td><td>${esc(m.cycle || '-')}</td>
        <td>${esc(m.owner)}</td><td class="num">${m.data_count || 0}</td>
        <td>${m.fieldsCount}</td><td><span class="${b[0]}">${b[1]}</span></td>
        <td class="row">
          <button class="btn sm pri" data-act="detail" data-id="${m.id}">模型详情/脱敏</button>
          <button class="btn sm" data-act="preview" data-id="${m.id}">数据预览</button>
          <button class="btn sm" data-act="status" data-id="${m.id}" data-status="PUBLISHED" ${m.status === 'PUBLISHED' ? 'disabled' : ''}>发布</button>
          <button class="btn sm" data-act="status" data-id="${m.id}" data-status="STOPPED" ${m.status !== 'PUBLISHED' ? 'disabled' : ''}>停用</button>
          <button class="btn sm" data-act="sync" data-id="${m.id}">同步元数据</button>
        </td></tr>`;
    }).join('');
    container.innerHTML = Shell.layout({ title: '分析模型管理 · 模型注册与元数据(F3-1)', active: '#/models', content: `
      <div class="card"><div class="hd">模型台账
        <div><button class="btn pri" data-act="reg">+ 注册模型（自动读取元数据）</button>
        <button class="btn" data-act="init">⚡一键初始化演示库(11模型+关系)</button></div></div>
        <div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr>
          <th>模型名称/物理表</th><th>模型编码</th><th>主题域</th><th>更新周期</th><th>责任人</th><th>数据量</th><th>字段数</th><th>状态</th><th>操作</th>
        </tr></thead><tbody>${rows || '<tr><td colspan="9" class="empty">尚未注册模型，点击“注册模型”或“一键初始化演示库”</td></tr>'}</tbody></table></div>
        <p class="muted" style="font-size:12px;margin:10px 0 0">注册时系统将连接业务数据源自动读取表注释、字段/类型/注释、敏感字段识别；发布后模型才能用于组合分析与预览。数据源共 ${meta.length} 张物理表。</p></div></div>` });

    container.querySelectorAll('[data-act=detail]').forEach((b) => b.onclick = () => detail(container, Number(b.dataset.id)));
    container.querySelectorAll('[data-act=preview]').forEach((b) => b.onclick = () => previewModel(container, Number(b.dataset.id)));
    container.querySelectorAll('[data-act=sync]').forEach((b) => b.onclick = async () => {
      const r = (await API.post('/api/models/' + b.dataset.id + '/sync')).data;
      U.ok('同步完成：新增' + r.added.join(',') + ' / 变更' + r.changed.join(',') + ' / 删除' + r.removed.join(','));
      list(container);
    });
    container.querySelectorAll('[data-act=status]').forEach((b) => b.onclick = async () => {
      const r = await API.post('/api/models/' + b.dataset.id + '/status', { status: b.dataset.status });
      if (r.data && r.data.need) U.warn(r.data.message || '已提交发布审批，请前往审批中心处理');
      else U.ok('状态已更新');
      list(container);
    });
    container.querySelector('[data-act=init]').onclick = async () => {
      if (!confirm('将把11张演示模型与默认关系补充注册（已存在则跳过），是否继续？')) return;
      const r = await API.post('/api/provision/demo');
      U.ok(r.message);
      list(container);
    };
    container.querySelector('[data-act=reg]').onclick = () => registerWizard(container);
  }

  async function registerWizard(container) {
    const meta = (await API.get('/api/meta/tables')).data;
    const unreg = meta.filter((t) => !t.registered);
    U.modal('注册模型 · 自动读取元数据(F3-1)', `
      <label>1. 选择业务数据源中的物理模型表（数据源：${'业务数据源'}<span id="dsName"></span>）</label>
      <select id="tableSel">${unreg.map((t) => `<option value="${esc(t.table)}">${t.cn ? esc(t.cn + ' · ') : ''}${esc(t.table)}</option>`).join('') || '<option value="">（已全部注册）</option>'}</select>
      <div class="row" style="margin-top:8px"><button class="btn pri" id="readMeta">2. 点击“读取元数据”自动回填字段清单</button></div>
      <div id="metaBox"></div>
      <div id="fieldsBox"></div>`, { wide: true, okText: '保存草稿并注册', onOk: async () => {
      const payload = window._regPayload;
      if (!payload) throw new Error('请先点击“读取元数据”');
      await API.post('/api/models', payload);
      U.ok('已注册为草稿，请在模型详情中确认业务属性与敏感等级后发布');
      list(container);
    } });
    const ds = (await API.get('/api/datasource/status')).data;
    const dsEl = document.getElementById('dsName');
    if (dsEl) dsEl.textContent = '：' + ds.name + (ds.message ? '(' + ds.message + ')' : '');
    document.getElementById('readMeta').onclick = async () => {
      const t = document.getElementById('tableSel').value;
      if (!t) { U.warn('没有可注册的物理表'); return; }
      const j = await API.get('/api/meta/read?table=' + encodeURIComponent(t));
      const meta2 = j.data;
      window._regPayload = null;
      const box = document.getElementById('metaBox');
      box.innerHTML = `<div class="row" style="margin-top:10px">
        <div style="flex:1"><label>模型中文名</label><input id="cn" value="${esc(meta2.catalog ? meta2.catalog.cn : t)}"></div>
        <div style="flex:1"><label>主题域</label><input id="topic" value="${esc(meta2.catalog ? meta2.catalog.topic : '')}"></div>
        <div style="flex:1"><label>更新周期</label><input id="cycle" value="${esc(meta2.catalog ? meta2.catalog.cycle : 'T+1')}"></div></div>
        <label>业务口径说明</label><input id="desc" value="${esc(meta2.catalog ? meta2.catalog.desc : '')}">
        <div class="muted" style="font-size:12px">已自动读取到 <b>${meta2.fields.length}</b> 个字段，疑似敏感字段已自动高亮标注（红色），请人工确认。</div>`;
      const fbox = document.getElementById('fieldsBox');
      fbox.innerHTML = `<div class="tb-wrap"><table class="tb"><thead><tr><th>字段名</th><th>类型</th><th>中文名(可改)</th><th>主键</th><th style="width:70px">敏感</th><th style="width:90px">等级</th><th style="width:160px">脱敏算法</th></tr></thead>
        <tbody>${meta2.fields.map((f, i) => `<tr data-i="${i}">
          <td class="mono">${esc(f.field_name)}</td><td>${esc(f.field_type)}</td>
          <td><input data-k="field_cn" value="${esc(f.field_cn || '')}" style="width:160px"></td>
          <td>${f.is_pk ? '是' : ''}</td>
          <td><input type="checkbox" data-k="is_sensitive" ${f.is_sensitive ? 'checked' : ''}></td>
          <td><select data-k="sens_level">${['', '高', '中', '低'].map((s) => `<option ${f.sens_level === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
          <td><select data-k="mask_alg">${['', 'MASK', 'TRUNC', 'HASH', 'ENCRYPT', 'BUCKET', 'EMPTY'].map((s) => `<option ${f.mask_alg === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        </tr>`).join('')}</tbody></table></div>`;
      const collect = () => {
        const fields = [...fbox.querySelectorAll('tbody tr')].map((tr) => {
          const i = Number(tr.dataset.i);
          const g = (k) => tr.querySelector(`[data-k=${k}]`).value;
          const sens = tr.querySelector('[data-k=is_sensitive]').checked;
          const alg = g('mask_alg') || (sens ? 'MASK' : '');
          return {
            field_name: meta2.fields[i].field_name, field_type: meta2.fields[i].field_type,
            nullable: meta2.fields[i].nullable, is_pk: meta2.fields[i].is_pk,
            field_cn: g('field_cn') || meta2.fields[i].field_cn,
            is_sensitive: sens, sens_level: sens ? (g('sens_level') || '高') : '',
            mask_alg: alg, mask_params: alg === 'MASK' ? { keepLeft: 3, keepRight: 4, maskChar: '*' } : (alg === 'TRUNC' ? { keep: 4 } : (alg === 'BUCKET' ? { bucketSize: 10 } : {})) };
        });
        window._regPayload = { physicalTable: t, model_name: document.getElementById('cn').value, topic: document.getElementById('topic').value, cycle: document.getElementById('cycle').value, biz_desc: document.getElementById('desc').value, owner: 'model_admin', fields };
      };
      fbox.querySelectorAll('input,select').forEach((el) => el.addEventListener('input', collect));
      box.querySelectorAll('input').forEach((el) => el.addEventListener('input', collect));
      collect();
      U.ok('元数据读取成功：' + meta2.fields.length + ' 个字段已自动回填');
    };
  }

  async function previewModel(container, id) {
    const j = await API.get('/api/models/' + id + '/preview?n=100');
    const d = j.data;
    M = d.model;
    const cols = d.fields;
    const rows = d.rows;
    const th = cols.map((c) => `<th title="${esc(c.field_name)}">${esc(c.field_cn || c.field_name)}${c.is_sensitive ? '<span class="tag red">敏</span>' : ''}</th>`).join('');
    const trs = rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c.field_name])}</td>`).join('')}</tr>`).join('');
    U.modal(`模型数据预览(F3-3) · ${esc(d.model.model_name)}`, `
      <div class="row muted" style="font-size:13px;margin-bottom:6px">总数据量 <b>${d.overview.total}</b> 行 · 字段 ${d.overview.fieldCount} 个 · 当前返回 ${d.rows.length} 行 · 当前角色脱敏生效
        <span class="tag red">敏感字段以脱敏形态展示，预览不落盘</span></div>
      <div class="tb-wrap" style="max-height:420px"><table class="tb"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>
      <div class="muted" style="font-size:12px;margin-top:6px">生成SQL（只读预览）：<code>${esc(d.sql)}</code></div>`, { wide: true });
  }

  async function detail(container, id) {
    M = await apiModel(id);
    const m = M;
    const b = STATUS_BADGE[m.status] || ['badge', m.status];
    const fieldRows = m.fields.map((f) => {
      const sens = f.is_sensitive === 1;
      return `<tr data-fid="${f.id}" ${sens ? 'style="background:#fff5f5"' : ''}>
        <td class="mono">${esc(f.field_name)}</td><td>${esc(f.field_type)}</td>
        <td><input data-k="field_cn" value="${esc(f.field_cn || '')}" style="width:150px"></td>
        <td>${f.is_pk ? '✓' : ''}</td>
        <td><input type="checkbox" data-k="is_sensitive" ${sens ? 'checked' : ''}></td>
        <td><select data-k="sens_level">${['', '高', '中', '低'].map((s) => `<option ${f.sens_level === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        <td><select data-k="mask_alg">${['', 'MASK', 'TRUNC', 'HASH', 'ENCRYPT', 'BUCKET', 'EMPTY'].map((s) => `<option ${f.mask_alg === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
        <td class="row"><button class="btn sm" data-act="maskp" data-fid="${f.id}">效果预览</button><button class="btn sm" data-act="savef" data-fid="${f.id}">保存</button></td>
      </tr>`;
    }).join('');
    const fval = (tr, k) => tr.querySelector(`[data-k=${k}]`).value;

    container.innerHTML = Shell.layout({ title: '模型详情与字段脱敏配置(F3-2)', active: '#/models', content: `
      <div class="row" style="margin-bottom:10px"><button class="btn" data-act="back">← 返回模型列表</button>
      <span class="${b[0]}">${b[1]}</span>
      ${m.status !== 'PUBLISHED' ? `<button class="btn pri" data-act="pub">发布</button>` : ''}
      <button class="btn" data-act="sync">重新同步物理表元数据</button></div>
      <div class="card"><div class="hd">基本信息 <button class="btn sm" data-act="saveinfo">保存基本信息</button></div>
        <div class="bd"><div class="grid3">
          <div><label>模型名称</label><input id="mi_cn" value="${esc(m.model_name)}"></div>
          <div><label>主题域</label><input id="mi_topic" value="${esc(m.topic || '')}"></div>
          <div><label>更新周期</label><input id="mi_cycle" value="${esc(m.cycle || '')}"></div>
          <div><label>业务分类</label><input id="mi_cat" value="${esc(m.biz_category || '')}"></div>
          <div><label>责任人</label><input id="mi_owner" value="${esc(m.owner || '')}"></div>
          <div><label>物理表(只读)</label><input value="${esc(m.physical_table)}" disabled></div>
        </div><label>业务口径说明</label><input id="mi_desc" value="${esc(m.biz_desc || '')}"></div></div>
      <div class="card"><div class="hd">字段清单与脱敏策略（红色=敏感字段，配置保存后全局生效）</div>
        <div class="bd"><div class="tb-wrap"><table class="tb"><thead><tr><th>字段</th><th>类型</th><th>中文名</th><th>主键</th><th>敏感</th><th>敏感等级</th><th>脱敏算法</th><th>操作</th></tr></thead>
        <tbody>${fieldRows}</tbody></table></div>
        <p class="muted" style="font-size:12px">脱敏算法说明：MASK掩码(138****5678) / TRUNC截断 / HASH加盐哈希 / ENCRYPT可逆加密 / BUCKET区间化 / EMPTY置空。未配置的敏感字段默认按掩码处理（默认安全）。</p></div></div>` });

    const wrap = container;
    const el = wrap;
    el.querySelector('[data-act=back]').onclick = () => list(container);
    el.querySelector('[data-act=pub]').onclick = async () => {
      const r = await API.post('/api/models/' + id + '/status', { status: 'PUBLISHED' });
      if (r.data && r.data.need) U.warn('已提交发布审批，等待审核');
      else U.ok('模型已发布，可用于组合分析');
      detail(container, id);
    };
    el.querySelector('[data-act=sync]').onclick = async () => {
      const r = (await API.post('/api/models/' + id + '/sync')).data;
      U.ok('元数据已同步：' + JSON.stringify({ added: r.added, changed: r.changed, removed: r.removed }));
      detail(container, id);
    };
    el.querySelector('[data-act=saveinfo]').onclick = async () => {
      await API.put('/api/models/' + id, { model_name: el.querySelector('#mi_cn').value, topic: el.querySelector('#mi_topic').value, cycle: el.querySelector('#mi_cycle').value, biz_category: el.querySelector('#mi_cat').value, owner: el.querySelector('#mi_owner').value, biz_desc: el.querySelector('#mi_desc').value });
      U.ok('基本信息已保存'); detail(container, id);
    };
    el.querySelectorAll('[data-act=savef]').forEach((b) => b.onclick = async () => {
      const tr = b.closest('tr');
      const alg = fval(tr, 'mask_alg');
      const sens = tr.querySelector('[data-k=is_sensitive]').checked;
      const params = alg === 'MASK' ? { keepLeft: 3, keepRight: 4, maskChar: '*' } : (alg === 'TRUNC' ? { keep: 4 } : (alg === 'BUCKET' ? { bucketSize: 10 } : {}));
      await API.put('/api/fields/' + b.dataset.fid, { field_cn: fval(tr, 'field_cn'), is_sensitive: sens ? 1 : 0, sens_level: sens ? (fval(tr, 'sens_level') || '高') : '', mask_alg: alg, mask_params: params });
      U.ok('脱敏策略已保存（模型预览/组合分析/结果/API 全局生效）');
      detail(container, id);
    });
    el.querySelectorAll('[data-act=maskp]').forEach((b) => b.onclick = async () => {
      const r = (await API.post('/api/models/' + id + '/mask-sample', { fieldId: Number(b.dataset.fid) })).data;
      const rowsTxt = r.raw.map((v, i) => `<tr><td class="mono">${esc(String(v))}</td><td class="mono">${esc(String(r.masked[i]))}</td></tr>`).join('');
      U.modal('脱敏效果预览(所见即所得)', `<p>字段：${esc(r.field.field_cn || r.field.field_name)} · 算法：${esc(r.field.mask_alg || '未配置(默认掩码)')} · 等级：${esc(r.field.sens_level) || '-'}</p>
        <table class="tb"><thead><tr><th>脱敏前(样例原值)</th><th>脱敏后</th></tr></thead><tbody>${rowsTxt}</tbody></table>`);
    });
  }

  // ============ 模型关系管理 F3-4 ============
  async function relations(container) {
    const rels = (await API.get('/api/relations')).data;
    const graph = (await API.get('/api/relations/graph')).data;
    const rows = rels.map((r) => `<tr>
      <td class="mono">${esc(r.rel_code)}</td><td>${esc(r.left_model_name)}</td><td>${esc((r.left_fields || '').replace(/[\[\]"]/g, ''))}</td>
      <td>${esc(r.rel_type)}</td><td>${esc(r.right_model_name)}</td><td>${esc((r.right_fields || '').replace(/[\[\]"]/g, ''))}</td>
      <td>${esc(r.biz_note || '-')}</td><td>${esc(r.confidence)}</td><td><span class="pill">使用${r.use_count}次</span></td>
      <td><span class="${r.status === 'ENABLED' ? 'badge ok' : 'badge'}">${r.status}</span></td>
      <td class="row"><button class="btn sm" data-act="toggle" data-id="${r.id}" data-st="${r.status === 'ENABLED' ? 'DISABLED' : 'ENABLED'}">${r.status === 'ENABLED' ? '停用' : '启用'}</button><button class="btn sm danger" data-act="del" data-id="${r.id}">删除</button></td>
    </tr>`).join('');

    const svg = renderGraph(graph);
    container.innerHTML = Shell.layout({ title: '分析模型管理 · 模型间关系配置(F3-4)', active: '#/relations', content: `
      <div class="row" style="margin-bottom:10px"><button class="btn pri" data-act="new">+ 新建模型关系</button><span class="muted">配置后，组合分析新增模型时将<b>自动推荐关联条件</b>并可一键采纳（F1-1）</span></div>
      <div class="card"><div class="hd">模型关系全景图（点击连线/节点查看详情）</div><div class="bd"><div class="graph">${svg}</div></div></div>
      <div class="card"><div class="hd">关系清单</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr>
        <th>关系编码</th><th>左模型</th><th>左关联字段</th><th>类型</th><th>右模型</th><th>右关联字段</th><th>业务说明</th><th>可信度</th><th>引用</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>${rows}</tbody></table></div></div></div>` });
    container.querySelector('[data-act=new]').onclick = () => newRelation(container);
    container.querySelectorAll('[data-act=toggle]').forEach((b) => b.onclick = async () => { await API.post('/api/relations/' + b.dataset.id + '/status', { status: b.dataset.st }); U.ok('已' + (b.dataset.st === 'ENABLED' ? '启用' : '停用')); relations(container); });
    container.querySelectorAll('[data-act=del]').forEach((b) => b.onclick = async () => { if (!confirm('确定删除该关系？')) return; await API.del('/api/relations/' + b.dataset.id); U.ok('已删除'); relations(container); });
  }

  function renderGraph(g) {
    const nodes = g.nodes || []; const edges = g.edges || [];
    const W = 1080, H = 430, cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) / 2 - 70;
    const pos = {};
    nodes.forEach((n, i) => { const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2 - Math.PI / 2; pos[n.id] = [cx + Math.cos(a) * R, cy + Math.sin(a) * R]; });
    const line = edges.map((e) => { const [x1, y1] = pos[e.from], [x2, y2] = pos[e.to]; return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#0b6ce1" stroke-width="2" stroke-dasharray="1 0" opacity=".5"/>`; }).join('');
    const nod = nodes.map((n) => { const [x, y] = pos[n.id]; return `<g><circle cx="${x}" cy="${y}" r="40" fill="#eef6ff" stroke="#0b6ce1" stroke-width="2"/><text x="${x}" y="${y - 6}" text-anchor="middle" font-size="11" fill="#0b2c52">${esc(String(n.label).slice(0, 6))}</text><text x="${x}" y="${y + 8}" text-anchor="middle" font-size="10" fill="#7487a1">${esc(String(n.label).slice(6, 12))}</text></g>`; }).join('');
    return `<svg viewBox="0 0 ${W} ${H}">${line}${nod}<text x="${W - 20}" y="${H - 10}" text-anchor="end" font-size="10" fill="#7487a1">节点=模型 · 连线=关联关系（共${edges.length}条）</text></svg>`;
  }

  async function newRelation(container) {
    const codes = (await API.get('/api/models/codes')).data.filter((m) => m.status === 'PUBLISHED');
    const sel = (selId, name, id) => `<select id="${id}" class="relModel">${codes.map((m) => `<option value="${m.id}">${esc(m.model_name)}</option>`).join('')}</select>`;
    U.modal('新建模型关系(F3-4)', `
      <div class="row">${sel('L', 'left', 'relL')} <b>关联到</b> ${sel('R', 'right', 'relR')}</div>
      <div class="row"><div style="flex:1"><label>左模型关联字段</label><select id="relLF" multiple style="height:110px"></select></div>
      <div style="flex:1"><label>右模型关联字段（顺序对应）</label><select id="relRF" multiple style="height:110px"></select></div></div>
      <div class="row"><div><label>关联类型</label><select id="relType">${['INNER', 'LEFT', 'RIGHT', 'FULL'].map((t) => `<option>${t}</option>`).join('')}</select></div>
      <div style="flex:1"><label>业务说明</label><input id="relNote" placeholder="例如：客户与投诉按客户标识关联"></div></div>
      <div class="row"><button type="button" class="btn" id="relCheck">校验关系(字段/行数膨胀)</button></div>
      <div id="relMsg"></div>`, { okText: '保存关系', onOk: async () => {
      const payload = {
        left_model_id: Number(document.getElementById('relL').value), right_model_id: Number(document.getElementById('relR').value),
        left_fields: [...document.getElementById('relLF').selectedOptions].map((o) => o.value),
        right_fields: [...document.getElementById('relRF').selectedOptions].map((o) => o.value),
        rel_type: document.getElementById('relType').value, biz_note: document.getElementById('relNote').value,
      };
      if (!payload.left_fields.length) throw new Error('请选择关联字段');
      await API.post('/api/relations', payload);
      U.ok('关系已保存并启用');
      relations(container);
    } });
    async function fill(mid, selId) {
      const m = (await API.get('/api/models/' + mid)).data;
      const el = document.getElementById(selId);
      el.innerHTML = m.fields.filter((f) => f.is_pk || /code|id|cust|month|province|phone/.test(f.field_name)).map((f) => `<option value="${esc(f.field_name)}">${esc(f.field_name)}(${esc(f.field_cn || '')})${f.is_pk ? '·主键' : ''}</option>`).join('');
    }
    await fill(document.getElementById('relL').value, 'relLF');
    await fill(document.getElementById('relR').value, 'relRF');
    document.querySelectorAll('.relModel').forEach((s) => s.onchange = async (e) => await fill(e.target.value, e.target.id === 'relL' ? 'relLF' : 'relRF'));
    document.getElementById('relCheck').onclick = async () => {
      const p = { left_model_id: Number(document.getElementById('relL').value), right_model_id: Number(document.getElementById('relR').value), left_fields: [...document.getElementById('relLF').selectedOptions].map((o) => o.value), right_fields: [...document.getElementById('relRF').selectedOptions].map((o) => o.value) };
      if (!p.left_fields.length) { U.warn('请先选择关联字段'); return; }
      const r = (await API.post('/api/relations/validate', p)).data;
      const msg = document.getElementById('relMsg');
      if (!r.ok) { msg.innerHTML = `<div class="badge err">校验未通过：${r.issues.join('；')}</div>`; return; }
      msg.innerHTML = `<div class="badge ok">校验通过。抽样左${r.sample.left}行/右${r.sample.right}行，关联结果${r.sample.joined}行。${r.warn ? '<div class="badge warn">' + r.warn + '</div>' : ''}</div>`;
    };
  }

  window.Views = window.Views || {}; window.Views.m3 = { list, detail, relations };
})();
