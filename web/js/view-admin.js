/* 系统管理视图：工作台 / 审批中心 / 审计日志 / 数据源与运行状态 */
(function () {
  const U = Util; const esc = U.esc;
  const TYPE_LABEL = { API_PUBLISH: 'API发布', API_OFFLINE: 'API下线', MODEL_PUBLISH: '模型发布' };

  async function home(container) {
    const ds = (await API.get('/api/datasource/status')).data;
    const [models, relations, funcs, flows, tasks, apis, apps, monitor] = await Promise.all([
      API.get('/api/models'), API.get('/api/relations'), API.get('/api/funcs'),
      API.get('/api/flows'), API.get('/api/tasks'), API.get('/api/open/apis'),
      API.get('/api/open/apps'), API.get('/api/open/monitor'),
    ]);
    const pmodels = models.data.filter((m) => m.status === 'PUBLISHED').length;
    const stat = (label, val, sub, nav, color) => `<div class="card" style="cursor:pointer" onclick="location.hash='${nav}'"><div class="bd"><div class="muted">${label}</div><b style="font-size:26px;color:${color}">${val}</b><div style="font-size:12px;color:#7487a1">${sub}</div></div></div>`;
    container.innerHTML = Shell.layout({ title: '工作台 · 三大模块能力总览', active: '#/home', content: `
      <div class="card" style="background:linear-gradient(120deg,#0b6ce1,#2b8ff0);color:#fff;border:none"><div class="bd" style="padding:18px 20px">
        <div style="font-size:18px;font-weight:700">在线服务公司 · 客户声音掘金研发（2026-2027）项目 · 包2</div>
        <div style="font-size:13px;opacity:.9;margin-top:6px">数据组合分析及开放能力 Demo —— 14个功能点全覆盖，评分项一一对应；数据源：${esc(ds.name)}${ds.message ? '（' + ds.message + '）' : ''}</div>
        <div style="margin-top:10px"><span class="badge ok">会话/令牌≤30分钟</span><span class="badge">RBAC多角色</span><span class="badge">操作全审计</span><span class="badge">敏感字段统一脱敏</span></div>
      </div></div>
      <div class="grid3">
        ${stat('三 · 分析模型管理', pmodels + '/11', '模型注册/脱敏/预览/关系(F3-1~4)', '#/models')}
        ${stat('一 · 数据组合分析', flows.data.length + ' 个流程', '跨模型关联/聚合/四则/函数/多步骤/任务(F1-1~7)', '#/analysis')}
        ${stat('二 · 分析结果开放', apis.data.length + ' 个API', '封装/鉴权/限流/加密(F2-1~3)', '#/apis')}
      </div>
      <div class="card"><div class="hd">快速进入功能演示（建议按评分顺序）</div><div class="bd">
        <table class="tb"><thead><tr><th>演示主题</th><th>功能点</th><th>说明</th><th>入口</th></tr></thead><tbody>
          <tr><td rowspan="7">一 · 数据组合分析（10分）</td><td>F1-1 多模型组合分析</td><td>≥2个模型画布关联（自动推荐）</td><td><a href="#/analysis">打开</a></td></tr>
          <tr><td>F1-2 求和与平均值</td><td>分组+SUM/AVG/COUNT</td><td><a href="#/analysis">打开</a></td></tr>
          <tr><td>F1-3 字段四则运算</td><td>派生字段、表达式试算、除零保护</td><td><a href="#/analysis">打开</a></td></tr>
          <tr><td>F1-4 多步骤取数</td><td>步骤编排/单步执行/中间结果预览</td><td><a href="#/analysis">打开</a></td></tr>
          <tr><td>F1-5 自定义函数</td><td>注册/测试/发布/调用转换</td><td><a href="#/funcs">打开</a></td></tr>
          <tr><td>F1-6 结果预览</td><td>结果表+SQL+日志，敏感已脱敏</td><td><a href="#/analysis">打开</a></td></tr>
          <tr><td>F1-7 取数任务管理</td><td>即时/周期Cron、状态机、终止/重跑</td><td><a href="#/tasks">打开</a></td></tr>
          <tr><td rowspan="3">二 · 分析结果开放（3分）</td><td>F2-1 API开放</td><td>结果封装API、调试、文档、监控</td><td><a href="#/apis">打开</a></td></tr>
          <tr><td>F2-2 认证鉴权</td><td>AppKey/Secret→Token、授权、限流</td><td><a href="#/sim">打开</a></td></tr>
          <tr><td>F2-3 内容加密</td><td>RSA+AES混合加密、调用方解密</td><td><a href="#/sim">打开</a></td></tr>
          <tr><td rowspan="4">三 · 分析模型管理（2分）</td><td>F3-1 模型注册/元数据自动读取</td><td>一键读取物理表元数据</td><td><a href="#/models">打开</a></td></tr>
          <tr><td>F3-2 字段脱敏配置</td><td>算法+等级+效果预览+全局生效</td><td><a href="#/models">打开</a></td></tr>
          <tr><td>F3-3 模型数据预览</td><td>样例数据+概要+取值分布</td><td><a href="#/models">打开</a></td></tr>
          <tr><td>F3-4 模型关系配置</td><td>关系视图+校验+自动推荐</td><td><a href="#/relations">打开</a></td></tr>
        </tbody></table>
        <p class="muted" style="font-size:12px">模型 ${models.data.length} 张 · 关系 ${relations.data.length} 条 · 函数 ${funcs.data.filter((f) => f.status === 'PUBLISHED').length} 个（内置）· 任务 ${tasks.data.length} 个 · API ${apis.data.length} 个 · 应用 ${apps.data.length} 个 · 调用 ${monitor.data.total} 次（成功${monitor.data.rows.reduce((s, r) => s + r.ok, 0)}）</p>
      </div></div>` });
    Shell.refreshBell();
  }

  async function approvals(container) {
    const [pending, all] = await Promise.all([API.get('/api/approvals/pending'), API.get('/api/approvals/all')]);
    const mk = (a) => `<tr><td>${esc(TYPE_LABEL[a.type] || a.type)}</td><td>${a.ref ? esc(a.ref.api_name || a.ref.model_name || ('#' + a.ref_id)) : '#' + a.ref_id}</td>
      <td>${esc(a.proposer)}</td><td>${esc(String(a.created_at))}</td>
      <td>${a.status === 'PENDING' ? '<span class="badge warn">待审批</span>' : a.status === 'APPROVED' ? '<span class="badge ok">已通过</span>' : '<span class="badge err">已驳回</span>'}</td>
      <td>${esc(a.approver || '-')}</td>
      ${a.status === 'PENDING' ? `<td class="row"><button class="btn ok sm" data-act="ok" data-id="${a.id}">通过</button><button class="btn danger sm" data-act="no" data-id="${a.id}">驳回</button></td>` : `<td>${esc(String(a.handled_at || ''))}</td>`}</tr>`;
    container.innerHTML = Shell.layout({ title: '系统管理 · 审批中心', active: '#/approvals', content: `
      <div class="step-guide"><b>说明</b>：模型发布 / API发布与下线 等涉敏与批量操作均需审批（结果审核人员/安全管理员）。审批后驱动状态流转并站内通知申请方。</div>
      <div class="card"><div class="hd">待审批（${pending.data.length}）</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr><th>类型</th><th>对象</th><th>申请人</th><th>时间</th><th>状态</th><th>审批人</th><th>操作</th></tr></thead><tbody>${pending.data.map(mk).join('') || '<tr><td colspan="7" class="empty">暂无待审批</td></tr>'}</tbody></table></div></div></div>
      <div class="card"><div class="hd">审批历史</div><div class="bd"><div class="tb-wrap full"><table class="tb"><thead><tr><th>类型</th><th>对象</th><th>申请人</th><th>时间</th><th>状态</th><th>审批人</th><th>审批时间</th></tr></thead><tbody>${all.data.slice(0, 50).map(mk).join('') || '<tr><td colspan="7" class="empty">暂无记录</td></tr>'}</tbody></table></div></div></div>` });
    container.querySelectorAll('[data-act=ok]').forEach((b) => b.onclick = async () => { await API.post('/api/approvals/' + b.dataset.id + '/act', { approve: true }); U.ok('已通过'); approvals(container); });
    container.querySelectorAll('[data-act=no]').forEach((b) => b.onclick = async () => { const reason = prompt('驳回原因', ''); await API.post('/api/approvals/' + b.dataset.id + '/act', { approve: false, reason: reason || '不满足发布要求' }); U.ok('已驳回'); approvals(container); });
  }

  async function audit(container) {
    const rows = (await API.get('/api/audit')).data;
    const trs = rows.map((a) => `<tr><td>${esc(String(a.created_at))}</td><td>${esc(a.actor)}</td><td>${esc(a.role)}</td><td>${esc(a.action)}</td><td>${esc(a.object_type)}</td><td class="mono muted" style="font-size:12px">${esc((a.detail || '').slice(0, 120))}</td><td>${esc(a.result)}</td></tr>`).join('');
    container.innerHTML = Shell.layout({ title: '系统管理 · 审计日志', active: '#/audit', content: `
      <div class="step-guide"><b>说明</b>：所有关键操作（敏感数据访问、权限变更、脱敏策略变更、模型/API上下线、凭证管理、任务操作、预览导出、函数变更）全量留痕，可查询检索。</div>
      <div class="card"><div class="hd">审计日志（最近300条）<button class="btn sm" data-act="refresh">刷新</button></div><div class="bd">
      <div class="tb-wrap full"><table class="tb"><thead><tr><th>时间</th><th>操作人</th><th>角色</th><th>动作</th><th>对象类型</th><th>详情</th><th>结果</th></tr></thead><tbody>${trs}</tbody></table></div></div></div>` });
    container.querySelector('[data-act=refresh]').onclick = () => audit(container);
  }

  async function ds(container) {
    const s = (await API.get('/api/datasource/status')).data;
    const [models, funcs, tasks, apis, apps, logs] = await Promise.all([
      API.get('/api/models'), API.get('/api/funcs'), API.get('/api/tasks'),
      API.get('/api/open/apis'), API.get('/api/open/apps'), API.get('/api/open/logs')]);
    container.innerHTML = Shell.layout({ title: '系统管理 · 数据源与运行状态', active: '#/ds', content: `
      <div class="grid3">
        <div class="card"><div class="hd">业务数据源（单一数据源）</div><div class="bd">
          <div class="kv">当前驱动：<b>${esc(s.actual)}</b></div>
          <div class="kv">数据源：${esc(s.name)}</div>
          <div class="kv">物理表数量：${esc(s.tableCount + '')}（自动建表+100行/表）</div>
          ${s.detail ? `<div class="kv mono" style="font-size:12px">${esc(JSON.stringify(s.detail))}</div>` : ''}
          <div class="muted" style="font-size:12px;margin-top:6px">${esc(s.message || '')}</div>
          <p style="font-size:12px;color:#0b6ce1;margin-top:8px">切换到 MySQL：<code>npm install mysql2</code> 并设置 <code>config.js</code> 中 <code>business.mysql</code>（host/port/db/user/password 已预置）。</p>
        </div></div>
        <div class="card"><div class="hd">运行状态</div><div class="bd">
          <div>注册表：${esc(s.registryDb)}</div>
          <div>注册模型 <b>${models.data.length}</b> · 函数 <b>${funcs.data.length}</b> · 任务 <b>${tasks.data.length}</b> · API <b>${apis.data.length}</b> · 应用 <b>${apps.data.length}</b> · 调用日志 <b>${logs.data.length}</b></div>
          <div>调度器：运行中（周期任务自动触发）</div>
        </div></div>
        <div class="card"><div class="hd">安全与合规</div><div class="bd" style="font-size:13px">
          <div>✓ 令牌有效期 ≤ 30分钟</div><div>✓ AppSecret 加密存储、一次性展示</div><div>✓ 敏感字段统一脱敏（各出口一致）</div>
          <div>✓ 混合加密 RSA-OAEP + AES-256-GCM</div><div>✓ 关键操作审计留痕</div><div>✓ 自定义函数受限沙箱</div>
        </div></div>
      </div>` });
  }

  window.Views = window.Views || {}; window.Views.admin = { home, approvals, audit, ds };
})();
