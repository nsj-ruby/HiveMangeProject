/* M2 分析结果开放视图：开放API(F2-1)、应用凭证(F2-2)、授权关系、调用监控、调用方模拟器(F2-3加解密) */
(function () {
  const U = Util; const esc = U.esc;
  const ST = { DRAFT: ['badge', '草稿'], PENDING: ['badge warn', '待审核'], PUBLISHED: ['badge ok', '已发布'], OFFLINE: ['badge', '已下线'], REJECTED: ['badge err', '已驳回'] };

  // ============ API 列表 / 新建 / 详情 ============
  async function apis(container) {
    const list = (await API.get('/api/open/apis')).data;
    const rows = list.map((a) => { const b = ST[a.status] || ['badge', a.status];
      return `<tr><td><b>${esc(a.api_name)}</b><div class="mono muted" style="font-size:12px">${esc(a.api_path)} v${a.version}</div></td>
      <td>${a.method}</td><td>${esc((JSON.parse(a.param_defs || '[]') || []).map((p) => p.name).join(',') || '-')}</td>
      <td>${a.return_struct}</td><td>${a.encrypt ? '<span class="tag blue">内容加密</span>' : '<span class="tag">明文</span>'}</td>
      <td><span class="${b[0]}">${b[1]}</span></td><td>${esc(a.owner)}</td><td class="num">${a.authzCount}</td>
      <td class="row">
      <button class="btn sm pri" data-act="detail" data-id="${a.id}">详情/调试/文档</button>
      ${a.status === 'DRAFT' || a.status === 'REJECTED' ? `<button class="btn sm" data-act="pub" data-id="${a.id}">申请发布</button>` : ''}
      ${a.status === 'PUBLISHED' ? `<button class="btn sm" data-act="off" data-id="${a.id}">下线</button>` : ''}
      </td></tr>`; }).join('');
    container.innerHTML = Shell.layout({ title: '分析结果开放 · 开放为API(F2-1)', active: '#/apis', content: `
      <div class="step-guide"><b>演示</b>：把“执行成功的取数任务结果”一键“开放为API”——自动带入参数/返回结构（数据总量/抽样/分页）；API发布需审核；支持在线调试、自动接口文档、状态管理与下线。敏感字段在API返回中按同一脱敏策略处理。</div>
      <div class="row" style="margin-bottom:10px"><button class="btn pri" data-act="new">+ 从取数结果开放为API</button>
      <button class="btn" data-act="refresh">刷新</button></div>
      <div class="card"><div class="hd">已封装API</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr>
        <th>API名称/路径</th><th>方式</th><th>请求参数</th><th>返回结构</th><th>加密</th><th>状态</th><th>创建人</th><th>授权应用数</th><th>操作</th>
      </tr></thead><tbody>${rows}</tbody></table></div></div></div>` });
    container.querySelector('[data-act=refresh]').onclick = () => apis(container);
    container.querySelector('[data-act=new]').onclick = () => openApiWizard(container);
    container.querySelectorAll('[data-act=detail]').forEach((b) => b.onclick = () => apiDetail(container, Number(b.dataset.id)));
    container.querySelectorAll('[data-act=pub]').forEach((b) => b.onclick = async () => { const r = await API.post('/api/open/apis/' + b.dataset.id + '/publish'); if (r.data && r.data.need) U.warn('已提交审批'); else U.ok('API已发布'); apis(container); });
    container.querySelectorAll('[data-act=off]').forEach((b) => b.onclick = async () => { const r = await API.post('/api/open/apis/' + b.dataset.id + '/offline'); if (r.data && r.data.need) U.warn('已提交下线审批'); else U.ok('API已下线'); apis(container); });
  }

  async function openApiWizard(container) {
    const tasks = (await API.get('/api/tasks')).data.filter((t) => t.status === 'SUCCESS');
    if (!tasks.length) { U.warn('请先执行一个成功的取数任务'); return; }
    const runs = [];
    for (const t of tasks) {
      const tt = (await API.get('/api/tasks/' + t.id)).data;
      (tt.runs || []).filter((r) => r.status === 'SUCCESS').forEach((r) => runs.push({ run: r, task: tt }));
    }
    if (!runs.length) { U.warn('没有成功运行的结果集'); return; }
    U.modal('开放为API（F2-1 · 一键封装取数结果）', `
      <label>API名称</label><input id="oa_name" placeholder="如：主副卡流量投诉高发客户群（API）">
      <label>服务路径（/open/v1/ 后部分，需唯一）</label><input id="oa_path" value="risk_flow_complaints" placeholder="risk_flow_complaints">
      <label>数据来源（已执行成功且在有效期内的取数结果）</label>
      <select id="oa_run">${runs.map((r, i) => `<option value="${r.run.id}">${esc(r.task.task_name)} · 运行#${r.run.run_no}（${r.run.row_count}行）</option>`).join('')}</select>
      <label>请求参数定义（格式：参数名:字段列名，多个逗号分隔；可空）</label><input id="oa_params" value="province:province_code" placeholder="province:province_code">
      <div class="grid3">
        <div><label>返回结构</label><select id="oa_struct"><option value="BOTH">数据总量+明细分页</option><option value="TOTAL">数据总量</option><option value="SAMPLE">取数抽样</option></select></div>
        <div><label>抽样条数/每页条数</label><input id="oa_sample" type="number" value="50"></div>
        <div><label>调用限流(次/秒，次/日)</label><div class="row"><input id="oa_lps" type="number" value="10" style="width:70px"><input id="oa_lpd" type="number" value="10000" style="width:90px"></div></div>
      </div>
      <label class="row"><input type="checkbox" id="oa_enc" checked> 启用数据内容混合加密（F2-3：RSA-OAEP 封钥 + AES-256-GCM 加密，调用方需登记公钥）</label>
      <label>接口说明</label><input id="oa_desc" placeholder="接口说明">`, { wide: true, okText: '创建API(草稿)', onOk: async () => {
      const runId = Number(document.getElementById('oa_run').value);
      const params = String(document.getElementById('oa_params').value || '').split(',').map((s) => s.trim()).filter(Boolean).map((kv) => {
        const [name, column] = kv.split(':'); return { name: (name || '').trim(), column: (column || name || '').trim(), type: 'STRING', required: false };
      }).filter((p) => p.name);
      const payload = {
        run_id: runId, api_name: document.getElementById('oa_name').value || '开放API', api_path: document.getElementById('oa_path').value,
        param_defs: params, return_struct: document.getElementById('oa_struct').value,
        sample_count: Number(document.getElementById('oa_sample').value) || 50, page_size: Number(document.getElementById('oa_sample').value) || 100,
        limit_per_sec: Number(document.getElementById('oa_lps').value) || 10, limit_per_day: Number(document.getElementById('oa_lpd').value) || 10000,
        encrypt: document.getElementById('oa_enc').checked ? 1 : 0, api_desc: document.getElementById('oa_desc').value,
      };
      if (!payload.api_path) throw new Error('请填写服务路径');
      const r = await API.post('/api/open/apis', payload);
      U.ok('API草稿已创建(#' + r.data.id + ')，下一步“申请发布”');
      apiDetail(container, r.data.id);
    } });
  }

  async function apiDetail(container, id) {
    const a = (await API.get('/api/open/apis/' + id)).data;
    const params = a.param_defs || [];
    const b = ST[a.status] || ['badge', a.status];
    const debugParamInputs = params.map((p) => `<div><label>${esc(p.name)}（${esc(p.column)}）</label><input id="dp_${esc(p.name)}" placeholder="${esc(p.name)}"></div>`).join('') || '<div class="muted">无请求参数</div>';
    const docParams = params.map((p) => `<tr><td class="mono">${esc(p.name)}</td><td>${esc(p.type)}</td><td>${esc(p.column)}</td><td>${p.required ? '必填' : '选填'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">无</td></tr>';
    container.innerHTML = Shell.layout({ title: 'API详情 · ' + esc(a.api_name), active: '#/apis', content: `
      <div class="row" style="margin-bottom:8px"><button class="btn" data-act="back">← API列表</button>
        <span class="mono">${esc(a.api_path)}</span><span class="${b[0]}">${b[1]}</span><span class="pill">来源任务 #${a.source_task_id}</span></div>
      <div class="grid2">
        <div class="card"><div class="hd">接口定义</div><div class="bd">
          <div class="kv"><div>名称：<b>${esc(a.api_name)}</b></div><div>路径：<span class="mono">${esc(a.api_path)}</span> · ${a.method}</div>
          <div>返回结构：${esc(a.return_struct)} · 抽样/分页：${esc(a.sample_count + '')}</div><div>限流：${esc(a.limit_per_sec + '')}次/秒 · ${esc(a.limit_per_day + '')}次/日</div>
          <div>加密：${a.encrypt ? '开启（' + esc(a.encrypt_alg) + '）' : '未开启'}</div><div>版本：v${a.version} · 创建人：${esc(a.owner)}</div></div>
          <div class="row" style="margin-top:8px">
            <button class="btn pri" data-act="pub" ${a.status === 'PUBLISHED' ? 'disabled' : ''}>${a.status === 'PENDING' ? '重新提交发布' : '申请发布'}</button>
            <button class="btn" data-act="off" ${a.status !== 'PUBLISHED' ? 'disabled' : ''}>下线</button>
            <button class="btn" data-act="saveret">保存(修改返回结构/抽样/限流)</button></div>
        </div></div>
        <div class="card"><div class="hd">请求参数 / 字段范围说明</div><div class="bd">
          <div class="tb-wrap full"><table class="tb"><thead><tr><th>参数</th><th>类型</th><th>对应结果列</th><th>必填</th></tr></thead><tbody>${docParams}</tbody></table></div>
          <p class="muted" style="font-size:12px">调用示例：<span class="mono">${esc(a.method)} ${esc(a.api_path)}?token=&lt;令牌&gt;${params.map((p) => '&' + esc(p.name) + '=&lt;值&gt;').join('')}</span></p>
        </div></div>
      </div>

      <div class="card"><div class="hd">在线调试(F2-1) / 加密内容演示</div><div class="bd">
        <div class="row" style="margin-bottom:6px"><button class="btn pri" data-act="debug">发起调用（在线调试）</button><span class="muted" id="dbgLat"></span></div>
        <div style="max-width:420px">${debugParamInputs}</div>
        <pre id="dbgOut" class="sqlbox" style="margin-top:8px">点击“发起调用”查看返回JSON…</pre>
      </div></div>

      <div class="card"><div class="hd">调用日志（最近）</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr><th>时间</th><th>应用</th><th>状态码</th><th>结果</th><th>耗时</th></tr></thead><tbody id="statBody"><tr><td colspan="5" class="empty">加载中…</td></tr></tbody></table></div></div></div>` });
    container.querySelector('[data-act=back]').onclick = () => apis(container);
    container.querySelector('[data-act=pub]').onclick = async () => { const r = await API.post('/api/open/apis/' + id + '/publish'); if (r.data.need) U.warn(r.data.message); else U.ok('已发布'); apiDetail(container, id); };
    container.querySelector('[data-act=off]').onclick = async () => { await API.post('/api/open/apis/' + id + '/offline'); apiDetail(container, id); };
    container.querySelector('[data-act=saveret]').onclick = async () => {
      await API.put('/api/open/apis/' + id, { sample_count: a.sample_count, limit_per_sec: a.limit_per_sec, limit_per_day: a.limit_per_day, encrypt: a.encrypt, api_desc: a.api_desc });
      U.ok('已保存（修改版本由audit留痕）');
    };
    container.querySelector('[data-act=debug]').onclick = async () => {
      const p = {};
      params.forEach((pp) => { const v = document.getElementById('dp_' + pp.name); if (v && v.value) p[pp.name] = v.value; });
      p.page = 1;
      try {
        const r = await API.post('/api/open/apis/' + id + '/debug', { params: p });
        document.getElementById('dbgOut').textContent = JSON.stringify(r.data, null, 2);
        document.getElementById('dbgLat').textContent = '响应耗时 ' + r.latency + 'ms（调试模式；实际调用经Token鉴权/限流/加密后返回）';
      } catch (e) { document.getElementById('dbgOut').textContent = '错误：' + e.message; }
    };
    loadStats();
    async function loadStats() {
      try {
        const logs = (await API.get('/api/open/apis/' + id + '/stats')).data;
        document.getElementById('statBody').innerHTML = logs.map((l) => `<tr><td>${esc(String(l.created_at))}</td><td>${esc(l.app_key || '-')}</td><td>${l.status_code}</td><td>${l.success ? '<span class="badge ok">成功</span>' : '<span class="badge err">' + esc(String(l.error || '失败').slice(0, 60)) + '</span>'}</td><td>${l.latency_ms}ms</td></tr>`).join('') || '<tr><td colspan="5" class="empty">暂无调用</td></tr>';
      } catch (e) {}
    }
  }

  // ============ 应用与凭证 ============
  async function apps(container) {
    const list = (await API.get('/api/open/apps')).data;
    const rows = list.map((a) => `<tr><td><b>${esc(a.app_name)}</b></td><td class="mono">${esc(a.app_key)}</td>
      <td><span class="${a.status === 'ACTIVE' ? 'badge ok' : 'badge err'}">${a.status === 'ACTIVE' ? '生效中' : '已吊销/停用'}</span></td><td>${esc(a.created_by)}</td><td>${esc(String(a.created_at))}</td>
      <td class="row">
      <button class="btn sm pri" data-act="secret" data-id="${a.id}">重置Secret</button>
      <button class="btn sm" data-act="st" data-id="${a.id}" data-st="${a.status === 'ACTIVE' ? 'REVOKED' : 'ACTIVE'}">${a.status === 'ACTIVE' ? '吊销' : '启用'}</button></td></tr>`).join('');
    container.innerHTML = Shell.layout({ title: '分析结果开放 · 应用与凭证管理(F2-2)', active: '#/apps', content: `
      <div class="step-guide"><b>说明</b>：为上层应用分配 <b>AppKey/AppSecret</b> 凭证对；AppSecret 加密保存、仅在创建/重置时完整展示一次。调用方凭凭证换取访问令牌（≤30分钟）。调用方还需在“调用方模拟器”中登记其RSA公钥用于内容加密。</div>
      <div class="row" style="margin-bottom:10px"><button class="btn pri" data-act="new">+ 创建应用</button><button class="btn" data-act="refresh">刷新</button></div>
      <div class="card"><div class="hd">应用列表</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr><th>应用</th><th>AppKey</th><th>状态</th><th>创建人</th><th>创建时间</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>` });
    container.querySelector('[data-act=new]').onclick = async () => {
      const name = prompt('应用名称（如：客户声音掘金应用）', '客户声音掘金应用');
      if (!name) return;
      const r = (await API.post('/api/open/apps', { app_name: name })).data;
      U.modal('应用创建成功 · 请妥善保存AppSecret（仅此一次展示）', `
        <p><b>AppKey</b>：<span class="mono">${esc(r.appKey)}</span></p>
        <p><b>AppSecret</b>：<span class="mono">${esc(r.appSecret)}</span></p>
        <p class="badge err">请复制保存。AppSecret不落明文存储，遗失只能重置。</p>`);
      apps(container);
    };
    container.querySelector('[data-act=refresh]').onclick = () => apps(container);
    container.querySelectorAll('[data-act=secret]').forEach((b) => b.onclick = async () => { const r = (await API.post('/api/open/apps/' + b.dataset.id + '/reset-secret')).data; alert('已重置。新 AppSecret：' + r.appSecret); });
    container.querySelectorAll('[data-act=st]').forEach((b) => b.onclick = async () => { await API.post('/api/open/apps/' + b.dataset.id + '/status', { status: b.dataset.st }); U.ok('已更新'); apps(container); });
  }

  // ============ 授权关系 ============
  async function authz(container) {
    const list = (await API.get('/api/open/authz')).data;
    const apps2 = (await API.get('/api/open/apps')).data;
    const apis2 = (await API.get('/api/open/apis')).data.filter((a) => a.status === 'PUBLISHED');
    const rows = list.map((z) => `<tr><td>${esc(z.app_name)}</td><td class="mono" style="font-size:12px">${esc(z.app_key)}</td><td>${esc(z.api_name)}<div class="mono muted" style="font-size:12px">${esc(z.api_path)}</div></td>
      <td class="mono" style="font-size:12px">${esc(JSON.stringify(JSON.parse(z.data_scope || '{}')))}</td>
      <td class="mono" style="font-size:12px">${esc((JSON.parse(z.field_scope || '[]') || []).join(',') || '*')}</td>
      <td><span class="${z.status === 'ACTIVE' ? 'badge ok' : 'badge'}">${z.status}</span></td>
      <td><button class="btn sm danger" data-act="rev" data-id="${z.id}">撤销</button></td></tr>`).join('');
    container.innerHTML = Shell.layout({ title: '分析结果开放 · 开放授权关系(F2-2)', active: '#/authz', content: `
      <div class="row" style="margin-bottom:10px"><button class="btn pri" data-act="new">+ 新建授权（应用→API）</button><button class="btn" data-act="refresh">刷新</button></div>
      <div class="card"><div class="hd">授权关系（应用—接口维度；数据范围/字段范围精细授权）</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr>
        <th>应用</th><th>AppKey</th><th>API</th><th>数据范围</th><th>字段范围</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>` });
    container.querySelector('[data-act=new]').onclick = async () => {
      U.modal('新建授权关系', `
        <label>应用</label><select id="az_app">${apps2.map((a) => `<option value="${a.id}">${esc(a.app_name)}(${esc(a.app_key)})</option>`).join('')}</select>
        <label>API</label><select id="az_api">${apis2.map((a) => `<option value="${a.id}">${esc(a.api_name)} · ${esc(a.api_path)}</option>`).join('')}</select>
        <label>数据范围（JSON，如 {"province_code":["410000","440000"]}，空=全部）</label><input id="az_scope" value='{}' placeholder='{"province_code":["410000"]}'>
        <label>字段范围（逗号分隔；空=默认返回列）</label><input id="az_fields" placeholder="可选字段别名列表">
        <label>备注</label><input id="az_note">`, { onOk: async () => {
        let ds = {}; try { ds = JSON.parse(document.getElementById('az_scope').value || '{}'); } catch (e) { throw new Error('数据范围JSON不合法'); }
        const fs = document.getElementById('az_fields').value.split(',').map((s) => s.trim()).filter(Boolean);
        const payload = { app_id: Number(document.getElementById('az_app').value), api_id: Number(document.getElementById('az_api').value), data_scope: ds, field_scope: fs, note: document.getElementById('az_note').value };
        await API.post('/api/open/authz', payload); U.ok('授权已建立（越权数据范围调用将被过滤）'); authz(container);
      } });
    };
    container.querySelector('[data-act=refresh]').onclick = () => authz(container);
    container.querySelectorAll('[data-act=rev]').forEach((b) => b.onclick = async () => { await API.post('/api/open/authz/' + b.dataset.id + '/revoke'); U.ok('已撤销'); authz(container); });
  }

  // ============ 调用日志 / 监控 ============
  async function logs(container) {
    const mon = (await API.get('/api/open/monitor')).data;
    const logs2 = (await API.get('/api/open/logs')).data;
    const rows = logs2.map((l) => `<tr><td>${esc(String(l.created_at))}</td><td>${esc(l.api_path || 'oauth/token')}</td><td class="mono" style="font-size:12px">${esc(l.app_key || '-')}</td>
      <td><span class="${l.success ? 'badge ok' : 'badge err'}">${l.success ? '成功' : '失败'}</span></td><td>${l.status_code}</td><td class="num">${l.latency_ms}ms</td>
      <td class="mono muted" style="font-size:12px">${esc((l.params || '').slice(0, 80))}</td></tr>`).join('');
    container.innerHTML = Shell.layout({ title: '分析结果开放 · API调用监控与日志', active: '#/logs', content: `
      <div class="grid3" style="margin-bottom:12px">
        <div class="card"><div class="bd"><div class="muted">总调用次数</div><b style="font-size:24px">${mon.total}</b></div></div>
        <div class="card"><div class="bd"><div class="muted">今日调用</div><b style="font-size:24px">${mon.today}</b></div></div>
        <div class="card"><div class="bd"><div class="muted">监控说明</div><span style="font-size:12px">每次调用均记录调用方/接口/时间/参数摘要/响应状态/耗时/IP（技术规范9.3/10.6）</span></div></div>
      </div>
      <div class="card"><div class="hd">按接口统计</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr><th>API</th><th>调用数</th><th>成功</th><th>失败</th><th>成功率</th><th>平均耗时</th><th>最近调用</th></tr></thead>
      <tbody>${mon.rows.map((r) => `<tr><td class="mono" style="font-size:12px">${esc(r.api_path)}</td><td class="num">${r.calls}</td><td class="num">${r.ok}</td><td class="num">${r.fail}</td><td>${r.calls ? Math.round(r.ok / r.calls * 100) : 0}%</td><td class="num">${r.avgms ? Math.round(r.avgms) : 0}ms</td><td>${esc(String(r.last))}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">暂无调用</td></tr>'}</tbody></table></div></div></div>
      <div class="card"><div class="hd">最近调用日志</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr><th>时间</th><th>接口</th><th>调用方</th><th>结果</th><th>状态码</th><th>耗时</th><th>参数摘要</th></tr></thead><tbody>${rows}</tbody></table></div></div></div>` });
  }

  // ============ 调用方模拟器 ============
  async function sim(container) {
    const apps2 = (await API.get('/api/open/apps')).data;
    const apis2 = (await API.get('/api/open/apis')).data.filter((a) => a.status === 'PUBLISHED');
    let state = { keyPair: null, pubJwk: null, token: '', keys: false, apiParams: {} };
    const selApp = `<select id="sim_app">${apps2.map((a) => `<option value="${a.id}" data-key="${esc(a.app_key)}">${esc(a.app_name)} (${esc(a.app_key)})</option>`).join('')}</select>`;
    container.innerHTML = Shell.layout({ title: '分析结果开放 · 调用方模拟器（认证鉴权+混合加密 F2-2/F2-3）', active: '#/sim', content: `
      <div class="step-guide"><b>端到端验证</b>：① 选择应用并填入AppSecret → ② 生成RSA密钥对并登记公钥 → ③ 换取访问令牌(≤30分钟) → ④ 调用开放API（先演示“不带令牌→401”，再演示“带令牌→加密密文返回”） → ⑤ 用浏览器WebCrypto解密还原明文。篡改密文可验证AES-GCM完整性校验。</div>
      <div class="grid2">
        <div class="card"><div class="hd">步骤1/2 · 应用与密钥</div><div class="bd">
          <label>选择应用（调用方）</label>${selApp}
          <label>AppSecret（创建/重置时展示，粘贴于此）</label><input id="sim_secret" placeholder="SK...">
          <div class="row"><button class="btn" data-act="genkey">生成RSA密钥对并登记公钥</button><span id="keyState"></span></div>
          <label>步骤3 · 获取访问令牌（OAuth2风格）</label><div class="row"><button class="btn pri" data-act="token">POST /open/oauth/token</button></div>
          <div><pre id="tokenBox" class="sqlbox" style="margin-top:6px;max-height:90px;overflow:auto">…</pre></div>
        </div></div>
        <div class="card"><div class="hd">步骤4/5 · 调用API并解密</div><div class="bd">
          <label>选择已发布API</label><select id="sim_api">${apis2.map((a) => `<option value="${a.id}">${esc(a.api_name)} · ${esc(a.api_path)}</option>`).join('') || '<option value="">（无已发布API）</option>'}</select>
          <label>业务参数（JSON，如 {"province":"410000","page":1}）</label><input id="sim_params" value='{"page":1}'>
          <div class="row">
            <button class="btn" data-act="call_naked">不带令牌调用(应401)</button>
            <button class="btn ok" data-act="call">带令牌调用(可能返回密文)</button>
            <button class="btn" data-act="decrypt">解密还原</button>
            <button class="btn danger" data-act="tamper">篡改密文→完整性失败</button>
          </div>
          <label>返回密文/响应</label><pre id="respBox" class="sqlbox" style="max-height:220px;overflow:auto">…</pre>
          <label>解密后的明文</label><pre id="plainBox" class="sqlbox" style="max-height:220px;overflow:auto">…</pre>
        </div></div>
      </div>` });

    async function curAppKey() {
      const opt = document.getElementById('sim_app').selectedOptions[0];
      return opt ? opt.dataset.key : '';
    }
    container.querySelector('[data-act=genkey]').onclick = async () => {
      const appId = Number(document.getElementById('sim_app').value);
      if (!appId) { U.warn('请先创建应用'); return; }
      const kp = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
      state.keyPair = kp;
      state.pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
      state.privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      await API.post('/api/open/apps/' + appId + '/pubkey', { jwk: state.pubJwk });
      state.keys = true;
      document.getElementById('keyState').textContent = '✅ 已登记RSA公钥(v1)';
      U.ok('RSA-2048密钥对已生成并登记为应用加密封装公钥');
    };
    container.querySelector('[data-act=token]').onclick = async () => {
      if (!state.keys) { U.warn('请先生成并登记公钥'); return; }
      const secret = document.getElementById('sim_secret').value;
      if (!secret) { U.warn('请粘贴AppSecret'); return; }
      try {
        const j = await fetch('/open/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appKey: await curAppKey(), appSecret: secret }) }).then((r) => r.json());
        if (j.code !== 0) { document.getElementById('tokenBox').textContent = '获取失败：' + j.message; return; }
        state.token = j.data.access_token;
        document.getElementById('tokenBox').textContent = 'access_token: ' + j.data.access_token + '\nexpires_in: ' + j.data.expires_in + '秒';
        U.ok('已获取访问令牌');
      } catch (e) { U.err(e.message); }
    };
    container.querySelector('[data-act=call_naked]').onclick = async () => {
      const path = selectedPath(); if (!path) { U.warn('无已发布API'); return; }
      const res = await fetch(path + '?x=1').then((r) => r.json());
      document.getElementById('respBox').textContent = 'HTTP无令牌调用 => code:' + res.code + ' ' + res.message;
      U.warn('未携带令牌调用被拒绝(401)，不返回任何业务数据');
    };
    container.querySelector('[data-act=call]').onclick = async () => {
      if (!state.token) { U.warn('请先获取令牌'); return; }
      const path = selectedPath(); if (!path) return;
      let params = {}; try { params = JSON.parse(document.getElementById('sim_params').value || '{}'); } catch (e) { U.err('参数JSON不合法'); return; }
      const qs = new URLSearchParams({ token: state.token, ...params }).toString();
      const start = Date.now();
      const j = await fetch(path + '?' + qs).then((r) => r.json());
      state.lastResp = j;
      const ms = Date.now() - start;
      document.getElementById('respBox').textContent = JSON.stringify(j, null, 2).slice(0, 3000) + '\n\n[耗时 ' + ms + 'ms]';
      if (j.encrypted) { document.getElementById('plainBox').textContent = '收到混合加密密文：AES-256-GCM 加密业务数据，AES会话密钥经 RSA-OAEP 用调用方公钥封装。点击“解密还原”。'; }
      else document.getElementById('plainBox').textContent = JSON.stringify(j.data || j, null, 2);
    };
    container.querySelector('[data-act=decrypt]').onclick = async () => {
      const j = state.lastResp;
      if (!j || !j.encrypted) { U.warn('没有待解密的密文响应'); return; }
      if (!state.keys) { U.warn('未持有私钥'); return; }
      try {
        const plain = await hybridDecryptWeb(state.privateJwk, j.env);
        document.getElementById('plainBox').textContent = JSON.stringify(plain, null, 2);
        U.ok('解密成功，明文与脱敏策略一致（敏感字段已按服务端策略脱敏）');
      } catch (e) { document.getElementById('plainBox').textContent = '解密失败：' + e.message; }
    };
    container.querySelector('[data-act=tamper]').onclick = async () => {
      const j = state.lastResp;
      if (!j || !j.encrypted) { U.warn('请先发起一次加密调用'); return; }
      const env = { ...j.env, ct: flipBase64(j.env.ct) };
      try {
        const plain = await hybridDecryptWeb(state.privateJwk, env);
        document.getElementById('plainBox').textContent = '⚠ 不应解密成功：' + JSON.stringify(plain).slice(0, 200);
      } catch (e) {
        document.getElementById('plainBox').textContent = '✅ 完整性校验失败（AES-256-GCM认证标签不匹配），篡改被识别：' + e.message;
      }
    };
    function selectedPath() {
      const apiId = document.getElementById('sim_api').value;
      const api = apis2.find((a) => a.id === Number(apiId));
      if (!api) { U.warn('请选择已发布API'); return null; }
      return api.api_path;
    }
  }

  function flipBase64(b64) {
    const bin = atob(b64).split('');
    bin[0] = String.fromCharCode(bin[0].charCodeAt(0) ^ 1);
    return btoa(bin.join(''));
  }

  async function hybridDecryptWeb(privateJwk, env) {
    const priv = await crypto.subtle.importKey('jwk', privateJwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
    const aesKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, priv, base64ToBuf(env.ek));
    const key = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-GCM' }, false, ['decrypt']);
    const ct = base64ToBuf(env.ct); const iv = base64ToBuf(env.iv); const tag = base64ToBuf(env.tag);
    const combined = new Uint8Array(ct.length + tag.length);
    combined.set(ct, 0); combined.set(tag, ct.length);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
    return JSON.parse(new TextDecoder().decode(plain));
  }
  function base64ToBuf(b64) {
    const s = atob(b64); const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  window.Views = window.Views || {}; window.Views.m2 = { apis, apps, authz, logs, sim };
})();
