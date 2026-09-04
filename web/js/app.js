/* 应用入口：路由 / 全局事件委托（导航/角色切换/消息） */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ROUTES = {
    '#/home': (c) => Views.admin.home(c),
    '#/models': (c) => Views.m3.list(c),
    '#/relations': (c) => Views.m3.relations(c),
    '#/analysis': (c) => Views.m1.analysis(c),
    '#/funcs': (c) => Views.m1.funcsView(c),
    '#/tasks': (c) => Views.m1.tasksView(c),
    '#/apis': (c) => Views.m2.apis(c),
    '#/apps': (c) => Views.m2.apps(c),
    '#/authz': (c) => Views.m2.authz(c),
    '#/logs': (c) => Views.m2.logs(c),
    '#/sim': (c) => Views.m2.sim(c),
    '#/approvals': (c) => Views.admin.approvals(c),
    '#/audit': (c) => Views.admin.audit(c),
    '#/ds': (c) => Views.admin.ds(c),
  };

  // 全局事件委托：绑定一次，DOM 反复替换后依然有效
  function bindDelegated() {
    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        e.preventDefault();
        const href = nav.getAttribute('data-nav');
        if (location.hash !== href) location.hash = href;
        return;
      }
      const bell = e.target.closest('#msgBell');
      if (bell) { openMessages(); return; }
    });
    document.addEventListener('change', (e) => {
      const rs = e.target;
      if (rs && rs.id === 'roleSwitcher') {
        Shell.doLogin(rs.value).then(() => route());
      }
    });
  }

  async function openMessages() {
    try {
      const j = await API.get('/api/auth/messages');
      const list = j.data.map((m) => `<div style="padding:6px 0;border-bottom:1px dashed #e4e9f2"><b>${esc(m.title)}</b><div style="font-size:12px;color:#7487a1">${esc(m.body)}</div><div class="muted" style="font-size:11px">${esc(String(m.created_at))}</div></div>`).join('') || '<div class="empty">暂无消息</div>';
      Util.modal('站内消息', list, { okText: '知道了' });
      j.data.forEach(async (m) => { if (!m.read) await API.post('/api/auth/messages/' + m.id + '/read'); });
      setTimeout(() => Shell.refreshBell(), 300);
    } catch (e) {}
  }

  async function route() {
    if (!API.getToken()) return Shell.renderLogin();
    const hash = location.hash && ROUTES[location.hash] ? location.hash : '#/home';
    const container = document.getElementById('app');
    container.innerHTML = '<div class="empty">加载中…</div>';
    try {
      await ROUTES[hash](container);
      // 视图内为按钮等再绑定自己的动作；导航/角色切换已由全局委托接管
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (msg.includes('请先登录') || (e && e.code === 401)) {
        API.setToken('');
        Shell.renderLogin();
        return;
      }
      Util.err('页面加载失败：' + msg);
      // 兜底：仍渲染带导航的布局，避免页面卡死、侧边栏失效
      container.innerHTML = Shell.layout({
        title: '页面加载失败', active: hash, content: `<div class="card"><div class="hd">提示</div><div class="bd">
        <p style="color:#c22121">页面加载失败：${esc(msg)}</p>
        <p class="muted">可继续使用左侧菜单切换；如反复出现，请把以上文案反馈给维护人员。</p></div></div>`,
      });
    }
  }

  function ensureAuth() {
    const token = API.getToken();
    if (!token) { Shell.renderLogin(); return; }
    API.get('/api/auth/me').then((j) => {
      Shell.ME = j.user;
      route();
    }).catch(() => {
      API.setToken('');
      Shell.renderLogin();
    });
  }

  // 初始化：加载用户列表（供登录页展示）并启动
  async function init() {
    try {
      const j = await fetch('/api/auth/users', { headers: { Authorization: 'Bearer ' + (API.getToken() || '') } }).then((r) => r.json());
      if (j.code === 0) Shell.setUsers(j.data);
    } catch (e) {}
    bindDelegated();
    window.addEventListener('hashchange', route);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureAuth);
    else ensureAuth();
  }
  init();
})();
