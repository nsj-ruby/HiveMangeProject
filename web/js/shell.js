/* 应用外壳：登录、顶栏、侧边栏、角色切换 */
window.Shell = (function () {
  let ME = null; // {username,name,role}
  const USERS = [];
  function setMe(u) { ME = u; }
  function getMe() { return ME; }
  function setUsers(list) { USERS.length = 0; USERS.push(...list); }

  function loginHtml() {
    return `<div class="login-wrap"><div class="login-card">
      <h1>客户声音掘金 · 数据组合分析及开放能力</h1>
      <div class="sub">在线服务公司客户声音掘金研发（2026-2027）项目 · 包2 —— Demo 演示环境<br>请选择演示账号登录（RBAC 多角色，支持随时切换以演示脱敏差异/审批流）</div>
      <div class="role-grid" id="roleGrid"></div>
      <div class="login-foot">安全提示：本环境使用仿真/脱敏数据；系统会话与开放令牌有效期均为 30 分钟，支持审计追溯。</div>
    </div></div>`;
  }

  function menuHtml(active) {
    const item = (href, label, icon = '•') => `<div class="mi ${active === href ? 'act' : ''}" data-nav="${href}"><span>${icon}</span>${label}</div>`;
    return `<div class="menu">
      ${item('#/home', '工作台', '⌂')}
      <div class="mi sec">三 · 分析模型管理</div>
      ${item('#/models', '模型注册与元数据', '🗂')}
      ${item('#/relations', '模型关系管理', '🔗')}
      <div class="mi sec">一 · 数据组合分析</div>
      ${item('#/analysis', '组合分析与多步骤取数', '🔬')}
      ${item('#/funcs', '自定义数据处理函数', 'ƒ')}
      ${item('#/tasks', '取数任务管理', '⏱')}
      <div class="mi sec">二 · 分析结果开放</div>
      ${item('#/apis', '分析结果开放API', '🔓')}
      ${item('#/apps', '应用与凭证(AppKey)', '🔑')}
      ${item('#/authz', '开放授权关系', '🛡')}
      ${item('#/logs', 'API调用监控', '📈')}
      ${item('#/sim', '调用方模拟器(加密解密)', '🧪')}
      <div class="mi sec">系统管理</div>
      ${item('#/approvals', '审批中心', '✔')}
      ${item('#/audit', '审计日志', '🕵')}
      ${item('#/ds', '数据源与运行状态', '🖥')}
    </div>`;
  }

  const FALLBACK = {
    sys_admin: '系统管理员', model_admin: '王模型(模型管理员)', analyst: '张运营(运营分析人员)',
    approver: '李审核(结果审核人员)', security_admin: '赵安全(安全管理员)',
  };
  function userList() {
    return USERS.length ? USERS : Object.keys(FALLBACK).map((u) => ({ username: u, display_name: FALLBACK[u] }));
  }

  function layout({ title, active, content, showTop = true }) {
    return `<div class="shell">
      <aside class="sidebar">
        <div class="brand">客户声音掘金<small>数据组合分析及开放能力 · Demo</small></div>
        ${menuHtml(active)}
        <div class="side-foot">
          <select id="roleSwitcher">${userList().map((u) => `<option value="${esc(u.username)}" ${ME && u.username === ME.username ? 'selected' : ''}>${esc(u.display_name)}</option>`).join('')}</select>
        </div>
      </aside>
      <div class="main">
        <div class="topbar">
          <div class="t">${esc(title || '')}</div>
          <div class="user">
            ${ME ? `<span class="badge">${esc(ME.name)} · ${esc(roleLabel(ME.role))}</span>` : ''}
            <span id="msgBell" style="cursor:pointer" title="站内消息">🔔<span id="msgCnt" class="pill" style="display:none"></span></span>
            <a href="#" data-nav="#/home">首页</a>
          </div>
        </div>
        <div class="content" id="content">${content || ''}</div>
      </div>
    </div>`;
  }

  function roleLabel(r) {
    const map = { ANALYST: '运营分析人员', MODEL_ADMIN: '模型管理员', APPROVER: '结果审核人员', SECURITY_ADMIN: '安全管理员', SYS_ADMIN: '系统管理员' };
    return map[r] || r;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function escRoleForShell() { return esc; }

  async function boot() {
    // 先拉取用户列表
    try {
      const j = await fetch('/api/auth/users', { headers: { Authorization: 'Bearer ' + (localStorage.getItem('sj_token') || 'x') } }).then((r) => r.json());
      if (j.code === 0) USERS.push(...j.data);
    } catch (e) { /* 未登录 */ }
    const token = API.getToken();
    if (!token) { renderLogin(); return; }
    try {
      const j = await API.get('/api/auth/me');
      setMe(j.user);
    } catch (e) {
      API.setToken('');
      renderLogin();
    }
  }

  function renderLogin() {
    document.getElementById('app').innerHTML = loginHtml();
    const grid = document.getElementById('roleGrid');
    const order = [['analyst', '运营分析人员', '创建组合分析、执行取数、开放结果（默认脱敏视角）'], ['model_admin', '模型管理员', '模型注册/元数据/脱敏/关系管理'], ['approver', '结果审核人员', 'API发布、模型发布、导出等审批'], ['security_admin', '安全管理员', '应用凭证、授权关系、调用审计']];
    grid.innerHTML = order.map(([u, name, desc]) => {
      const usr = USERS.find((x) => x.username === u);
      return `<button class="role-btn" data-login="${esc(u)}"><div class="rname">${esc(usr ? usr.display_name : name)}</div><div class="rdesc">${esc(desc)}</div></button>`;
    }).join('');
    grid.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-login]');
      if (!b) return;
      await doLogin(b.getAttribute('data-login'));
      location.hash = '#/home';
    });
  }

  async function doLogin(username) {
    try {
      const j = await API.post('/api/auth/login', { username });
      API.setToken(j.token);
      setMe(j.user);
      Util.ok('登录成功：' + j.user.name);
    } catch (e) { Util.err(e.message); }
  }

  async function switchRole(username) {
    await doLogin(username);
  }

  async function renderLayout(route) {
    const app = document.getElementById('app');
    const content = document.getElementById('content') || '';
    if (route === undefined) {
      // 已有 shell，仅刷新内容区域
    }
    // 重新渲染（简单可靠）
    if (route !== undefined) { document.getElementById('app').innerHTML = route; return; }
  }

  function notifyHtml() {
    return `<div style="padding:10px 0">暂无消息</div>`;
  }

  async function refreshBell() {
    try {
      const j = await API.get('/api/auth/messages');
      const el = document.getElementById('msgCnt');
      if (el) { el.textContent = j.unread || ''; el.style.display = j.unread ? 'inline-block' : 'none'; }
    } catch (e) {}
  }

  const api = {
    boot, renderLogin, layout, roleLabel, esc, USERS, doLogin, switchRole, refreshBell,
    roleLabelFn: roleLabel, setMe, getMe, setUsers,
    get ME() { return ME; }, set ME(v) { ME = v; },
  };
  return api;
})();
window.esc = Shell.esc;
