// The "Chat with us" button and panel for customers. It is added to a page with one line:
//   <script src="chat-widget.js"></script>
(() => {
  const token = () => localStorage.getItem('ehm_token');
  const css = document.createElement('style');
  css.textContent = `
    .ehm-btn{position:fixed;right:16px;bottom:16px;z-index:9999;background:#F2A900;color:#2A1A00;border:0;border-radius:999px;padding:13px 20px;font:700 15px "DM Sans",Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer}
    .ehm-badge{display:none;background:#B3261E;color:#fff;border-radius:999px;padding:1px 8px;font-size:12px;margin-left:8px}
    .ehm-panel{position:fixed;right:16px;bottom:76px;z-index:9999;width:min(360px,calc(100vw - 32px));height:min(480px,70vh);background:#fff;border:1px solid #EADFCE;border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font-family:"DM Sans",Arial,sans-serif;color:#3B2318}
    .ehm-panel.open{display:flex}
    .ehm-head{background:#3B2318;color:#FFF4DC;padding:12px 14px;display:flex;justify-content:space-between;align-items:center;font-weight:700}
    .ehm-x{background:none;border:0;color:#FFF4DC;font-size:22px;cursor:pointer;line-height:1}
    .ehm-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#FFFDF8}
    .ehm-m{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;word-wrap:break-word;white-space:pre-wrap}
    .ehm-m small{display:block;font-size:11px;opacity:.7;margin-bottom:2px}
    .ehm-me{align-self:flex-end;background:#3B2318;color:#fff}
    .ehm-bot{align-self:flex-start;background:#fff;border:1px solid #EADFCE}
    .ehm-staff{align-self:flex-start;background:#FBF0D6;border:1px solid #F2A900}
    .ehm-form{display:flex;gap:8px;padding:10px;border-top:1px solid #EADFCE;background:#fff}
    .ehm-form input{flex:1;min-width:0;padding:10px 12px;border:1.5px solid #EADFCE;border-radius:999px;font:inherit;font-size:14px}
    .ehm-form button{background:#F2A900;color:#2A1A00;border:0;border-radius:999px;padding:10px 16px;font:700 14px "DM Sans",Arial,sans-serif;cursor:pointer}
    .ehm-note{color:#6B5648;font-size:13px;padding:6px 2px}
    .ehm-note a{color:#3B2318;font-weight:700}`;
  document.head.appendChild(css);

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const btn = el('button', 'ehm-btn', 'Chat with us'); btn.type = 'button'; btn.setAttribute('aria-label', 'Open chat');
  const badge = el('span', 'ehm-badge'); btn.appendChild(badge);
  const panel = el('div', 'ehm-panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat with the shop');
  const head = el('div', 'ehm-head'); head.appendChild(el('span', '', 'Chat with Emmahenmic'));
  const x = el('button', 'ehm-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close chat'); head.appendChild(x);
  const log = el('div', 'ehm-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
  const form = el('form', 'ehm-form');
  const input = el('input'); input.placeholder = 'Type your message...'; input.maxLength = 500; input.setAttribute('aria-label', 'Your message');
  const send = el('button', '', 'Send'); send.type = 'submit';
  form.append(input, send);
  panel.append(head, log, form);
  document.body.append(panel, btn);

  let open = false, timer = null, canChat = false;
  const note = (html) => { log.innerHTML = ''; const n = el('div', 'ehm-note'); n.append(...html); log.appendChild(n); form.style.display = 'none'; };
  const link = (href, text) => { const a = el('a', '', text); a.href = href; return a; };

  async function api(url, opts) {
    const res = await fetch(url, { ...(opts || {}), headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' } });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  function draw(messages) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.innerHTML = '';
    if (!messages.length) log.appendChild(el('div', 'ehm-note', 'Hello! Ask us about delivery, payment, prices or your order.'));
    messages.forEach(m => {
      const b = el('div', 'ehm-m ' + (m.sender === 'customer' ? 'ehm-me' : m.sender === 'staff' ? 'ehm-staff' : 'ehm-bot'));
      if (m.sender !== 'customer') b.appendChild(el('small', '', m.sender === 'staff' ? 'Shop team' : 'Automatic reply'));
      b.append(document.createTextNode(m.message)); log.appendChild(b);
    });
    if (nearBottom || messages.length < 3) log.scrollTop = log.scrollHeight;
  }

  async function load() {
    const r = await api('/api/chat');
    if (r.ok) { draw(r.data.messages); return; }
    if (r.status === 401) { localStorage.removeItem('ehm_token'); showLogin(); }
  }
  function showLogin() {
    canChat = false;
    note(['Please ', link('/login.html?next=' + encodeURIComponent(location.pathname + location.search), 'log in'), ' to chat with the shop.']);
  }
  async function openPanel() {
    open = true; panel.classList.add('open'); badge.style.display = 'none';
    if (!token()) { showLogin(); return; }
    const me = await api('/api/me');
    if (!me.ok) { localStorage.removeItem('ehm_token'); showLogin(); return; }
    if (me.data.role !== 'customer') { note(['You are logged in as shop staff. Reply to customers on the ', link('/admin-chat.html', 'Messages page'), '.']); return; }
    canChat = true; form.style.display = 'flex'; await load(); input.focus();
    timer = setInterval(() => { if (!document.hidden) load(); }, 4000);
  }
  function closePanel() { open = false; panel.classList.remove('open'); clearInterval(timer); updateBadge(); }

  async function updateBadge() {
    if (open || !token() || document.hidden) return;
    const r = await api('/api/chat/unread');
    if (r.ok && r.data.unread > 0) { badge.textContent = r.data.unread; badge.style.display = 'inline-block'; } else badge.style.display = 'none';
  }

  btn.onclick = () => open ? closePanel() : openPanel();
  x.onclick = closePanel;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) closePanel(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !canChat) return;
    send.disabled = true;
    const r = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: text }) });
    send.disabled = false;
    if (r.ok) { input.value = ''; await load(); log.scrollTop = log.scrollHeight; }
    else { const n = el('div', 'ehm-note', r.data.error || 'Could not send. Try again.'); n.style.color = '#B3261E'; log.appendChild(n); log.scrollTop = log.scrollHeight; }
  };
  window.ehmOpenChat = () => { if (!open) openPanel(); };   // lets the left menu open the chat
  updateBadge(); setInterval(updateBadge, 30000);
})();