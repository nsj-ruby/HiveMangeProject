/* 通用工具与 UI 组件 */
window.API = (function () {
  let TOKEN = localStorage.getItem('sj_token') || '';
  const setToken = (t) => { TOKEN = t; t ? localStorage.setItem('sj_token', t) : localStorage.removeItem('sj_token'); };
  const getToken = () => TOKEN;

  async function request(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const opt = { method, headers };
    if (body !== undefined) opt.body = JSON.stringify(body);
    const res = await fetch(url, opt);
    let j = null;
    try { j = await res.json(); } catch (e) { throw new Error('服务返回异常(HTTP ' + res.status + ')'); }
    if (!res.ok || (j && j.code && j.code !== 0)) {
      const e = new Error((j && j.message) || ('请求失败 HTTP ' + res.status));
      e.code = j && j.code; e.raw = j; throw e;
    }
    return j;
  }
  const get = (u) => request('GET', u);
  const post = (u, b) => request('POST', u, b || {});
  const put = (u, b) => request('PUT', u, b || {});
  const del = (u) => request('DELETE', u);

  return { setToken, getToken, request, get, post, put, del };
})();

window.Util = (function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmt(v, col) {
    if (v == null || v === '') return '<span class="muted">-</span>';
    if (col && col.type === 'NUMBER' && typeof v === 'number') return v.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
    return esc(String(v));
  }
  const json = (o) => JSON.stringify(o, null, 2);
  const nowStr = () => new Date().toLocaleString('zh-CN', { hour12: false });
  function toast(msg, type) {
    let box = document.querySelector('.toast');
    if (!box) { box = document.createElement('div'); box.className = 'toast'; document.body.appendChild(box); }
    const d = document.createElement('div');
    d.className = type || ''; d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => { d.remove(); }, 3600);
  }
  function ok(msg) { toast(msg, 'ok'); }
  function warn(msg) { toast(msg, 'warn'); }
  function err(msg) { toast(msg, 'err'); }

  function modal(title, inner, { onOk, okText = '确定', wide = false } = {}) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(9,20,35,.45);z-index:9000;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:40px 12px';
      const box = document.createElement('div');
      box.style.cssText = `background:#fff;border-radius:12px;width:${wide ? '1100px' : '760px'};max-width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)`;
      const hd = document.createElement('div');
      hd.style.cssText = 'padding:12px 16px;border-bottom:1px solid #e4e9f2;font-weight:700;display:flex;justify-content:space-between';
      hd.innerHTML = `<span>${esc(title)}</span><span class="close-x" style="cursor:pointer;color:#7487a1">✕</span>`;
      const bd = document.createElement('div');
      bd.style.cssText = 'padding:14px 16px;max-height:76vh;overflow:auto';
      bd.innerHTML = inner;
      const ft = document.createElement('div');
      ft.style.cssText = 'padding:12px 16px;border-top:1px solid #e4e9f2;text-align:right;display:none';
      ft.innerHTML = `<button class="btn m-cancel">取消</button> <button class="btn pri m-ok">${esc(okText)}</button>`;
      box.append(hd, bd, ft);
      wrap.appendChild(box);
      wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('.close-x')) { wrap.remove(); resolve(null); } });
      hd.querySelector('.close-x').onclick = () => { wrap.remove(); resolve(null); };
      if (onOk) {
        ft.style.display = 'block';
        ft.querySelector('.m-cancel').onclick = () => { wrap.remove(); resolve(null); };
        ft.querySelector('.m-ok').onclick = async () => { try { const r = await onOk(); resolve(r); wrap.remove(); } catch (e) { err(e.message); } };
      }
      document.body.appendChild(wrap);
      // 收集输入值：_val 控件由内部脚本填充
      return null;
    });
  }
  function closeModals() { document.querySelectorAll('.toast').forEach((x) => x.remove()); }

  /* 通用只读表格（支持搜索/排序/列显隐） */
  function table(opts) {
    const { columns, rows } = opts; // columns:[{key,label,type,render}]
    const state = { kw: '', order: null, dir: 1, hidden: {} };
    function filtered() {
      let arr = rows || [];
      if (state.kw) arr = arr.filter((r) => columns.some((c) => String(r[c.key] == null ? '' : r[c.key]).toLowerCase().includes(state.kw.toLowerCase())));
      if (state.order) {
        const c = columns.find((x) => x.key === state.order);
        arr = [...arr].sort((a, b) => {
          const av = a[state.order], bv = b[state.order];
          const an = typeof av === 'number' ? av : (av == null ? null : Number(av));
          const bn = typeof bv === 'number' ? bv : (bv == null ? null : Number(bv));
          let r = 0;
          if (an != null && bn != null && !Number.isNaN(an) && !Number.isNaN(bn)) r = an - bn;
          else r = String(av == null ? '' : av).localeCompare(String(bv == null ? '' : bv), 'zh');
          return r * state.dir;
        });
      }
      return arr;
    }
    function render() {
      const vis = columns.filter((c) => !state.hidden[c.key]);
      const trs = filtered().slice(0, 3000).map((r) => `<tr>${vis.map((c) => {
        const v = c.render ? c.render(r[c.key], r) : fmt(r[c.key], c);
        return `<td class="${c.type === 'NUMBER' ? 'num mono' : ''}">${v}</td>`;
      }).join('')}</tr>`).join('') || `<tr><td colspan="${vis.length}" class="empty">暂无数据</td></tr>`;
      const ths = vis.map((c) => {
        const arrow = state.order === c.key ? (state.dir > 0 ? ' ▲' : ' ▼') : '';
        return `<th data-k="${esc(c.key)}" style="cursor:pointer">${esc(c.label || c.key)}${arrow}</th>`;
      }).join('');
      return `<div class="row" style="margin-bottom:8px">
        <input type="text" class="tbl-kw" placeholder="关键字搜索…" value="${esc(state.kw)}" style="max-width:240px">
        <span class="muted" style="font-size:12px">共 ${(rows || []).length} 行</span>
      </div>
      <div class="tb-wrap full"><table class="tb"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
    }
    return { render };
  }

  return { esc, fmt, json, toast, ok, warn, err, modal, table, closeModals, nowStr };
})();
