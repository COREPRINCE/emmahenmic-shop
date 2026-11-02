// The left menu for EVERY page of the site. It shows only the links that the person needs:
//   a visitor or customer sees the shop links, staff see order work, the owner sees everything.
// Added to a page with one line:  <script src="site-nav.js"></script>
(() => {
  const token = localStorage.getItem('ehm_token');
  const auth = token ? { Authorization: 'Bearer ' + token } : {};
  const file = location.pathname.split('/').pop() || 'index.html';
  const SHOP_PAGES = ['index.html', 'cart.html', 'order.html', 'my-orders.html'];
  const isShop = SHOP_PAGES.includes(file);
  if (!token && !isShop) return;          // owner pages send visitors to the login by themselves

  // ---- the links ----
  const SHOP_ITEMS = [
    { label: 'Shop', href: '/', files: ['index.html'] },
    { label: 'Cart', href: 'cart.html', files: ['cart.html'], cart: true },
    { label: 'My orders', href: 'my-orders.html', files: ['my-orders.html', 'order.html'], loginOnly: true },
    { label: 'Chat with us', action: () => { if (window.ehmOpenChat) window.ehmOpenChat(); } }
  ];
  // owner: true = only the owner sees it. badge = a number shown beside it.
  const ADMIN_ITEMS = [
    { label: 'Dashboard', href: 'admin.html', files: ['admin.html'] },
    { label: 'Orders', href: 'admin-orders.html', files: ['admin-orders.html'], plain: true },
    { label: 'Payment approvals', href: 'admin-orders.html?pay=check', files: ['admin-orders.html'], pay: true, badge: 'receipts_to_check' },
    { label: 'Messages', href: 'admin-chat.html', files: ['admin-chat.html'], badge: 'unread_chats' },
    { label: 'Products and prices', href: 'add-product.html', files: ['add-product.html'], owner: true },
    { label: 'Stock', href: 'admin-stock.html', files: ['admin-stock.html'] },
    { label: 'Delivery areas', href: 'admin-zones.html', files: ['admin-zones.html'], owner: true },
    { label: 'Employees', href: 'admin-staff.html', files: ['admin-staff.html'], owner: true },
    { label: 'Adverts', href: 'promotions.html', files: ['promotions.html'], owner: true },
    { label: 'Reports', href: 'admin-reports.html', files: ['admin-reports.html'], owner: true },
    { label: 'Activity log', href: 'admin-audit.html', files: ['admin-audit.html'], owner: true }
  ];

  const css = document.createElement('style');
  css.textContent = `
    body.ehm-nav { margin-left: 250px; }
    body.ehm-nav > header { display: none; }
    .ehm-side { position: fixed; top: 0; left: 0; bottom: 0; width: 250px; background: #3B2318; color: #FFF4DC; display: flex; flex-direction: column; padding: 18px 0; z-index: 900; font-family: "DM Sans", Arial, sans-serif; overflow-y: auto; }
    .ehm-brand { padding: 0 22px 16px; font-size: 20px; font-family: "DM Serif Display", Georgia, serif; }
    .ehm-brand small { display: block; font: 400 13px "DM Sans", Arial, sans-serif; opacity: .75; }
    .ehm-side a.ehm-i { display: flex; justify-content: space-between; align-items: center; gap: 8px; color: #FFF4DC; text-decoration: none; font-weight: 500; padding: 12px 14px; margin: 2px 12px; border-radius: 10px; cursor: pointer; }
    .ehm-side a.ehm-i:hover { background: rgba(255,255,255,.1); }
    .ehm-side a.ehm-i[aria-current="page"] { background: #F2A900; color: #2A1A00; font-weight: 700; }
    .ehm-n { background: #B3261E; color: #fff; border-radius: 999px; padding: 1px 8px; font-size: 12px; font-weight: 700; }
    .ehm-n.cart { background: #F2A900; color: #2A1A00; }
    .ehm-foot { margin-top: auto; padding: 16px 22px 0; font-size: 13px; opacity: .9; border-top: 1px solid rgba(255,255,255,.15); }
    .ehm-foot a { display: block; color: #FFF4DC; margin-top: 8px; }
    .ehm-top { display: none; position: fixed; top: 0; left: 0; right: 0; height: 56px; background: #3B2318; color: #FFF4DC; align-items: center; gap: 12px; padding: 0 14px; z-index: 800; font: 700 18px "DM Serif Display", Georgia, serif; }
    .ehm-top button { background: none; border: 0; color: #FFF4DC; font-size: 26px; cursor: pointer; line-height: 1; padding: 6px 8px; }
    .ehm-top a { margin-left: auto; color: #F2A900; text-decoration: none; font: 700 15px "DM Sans", Arial, sans-serif; }
    .ehm-shade { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 850; }
    @media (max-width: 860px) {
      body.ehm-nav { margin-left: 0; padding-top: 56px; }
      .ehm-top { display: flex; }
      .ehm-side { transform: translateX(-100%); transition: transform .2s; }
      .ehm-side.open { transform: none; }
      .ehm-side.open ~ .ehm-shade { display: block; }
    }
    @media (prefers-reduced-motion: reduce) { .ehm-side { transition: none; } }`;
  document.head.appendChild(css);

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const cartCount = () => { try { return Object.values(JSON.parse(localStorage.getItem('ehm_cart')) || {}).reduce((a, b) => a + b, 0); } catch (e) { return 0; } };

  (async () => {
    let me = null;
    if (token) {
      try {
        const r = await fetch('/api/me', { headers: auth });
        if (r.ok) me = await r.json(); else if (r.status === 401) localStorage.removeItem('ehm_token');
      } catch (e) {}
    }
    const role = me ? me.role : 'guest';
    const isAdmin = role === 'owner' || role === 'staff';
    if (!isShop && !isAdmin) return;      // a customer on an owner page is sent away by the page itself

    const payFilter = new URLSearchParams(location.search).get('pay') === 'check';
    const side = el('nav', 'ehm-side'); side.setAttribute('aria-label', 'Main menu');
    const brand = el('div', 'ehm-brand', 'Emmahenmic');
    brand.appendChild(el('small', '', role === 'owner' ? 'Owner area' : role === 'staff' ? 'Staff area' : 'The Great Business Ent'));
    side.appendChild(brand);

    let items = [];
    if (isAdmin) {
      if (isShop) items.push(...SHOP_ITEMS.filter(i => !i.loginOnly && i.label !== 'Chat with us'));
      items.push(...ADMIN_ITEMS.filter(i => !i.owner || role === 'owner'));
    } else {
      items = SHOP_ITEMS.filter(i => !i.loginOnly || me);
    }

    const badges = {}, cartBadges = [];
    items.forEach(i => {
      const a = el('a', 'ehm-i'); a.appendChild(el('span', '', i.label));
      if (i.href) a.href = i.href; else { a.href = '#'; a.onclick = (e) => { e.preventDefault(); toggle(false); i.action(); }; }
      if (i.files && i.files.includes(file) && (!(i.plain || i.pay) || (i.pay === true) === payFilter)) a.setAttribute('aria-current', 'page');
      if (i.badge) { const n = el('span', 'ehm-n'); n.style.display = 'none'; a.appendChild(n); badges[i.badge] = n; }
      if (i.cart) { const n = el('span', 'ehm-n cart'); n.style.display = 'none'; a.appendChild(n); cartBadges.push(n); }
      side.appendChild(a);
    });
    if (!me) {
      const login = el('a', 'ehm-i'); login.appendChild(el('span', '', 'Log in or sign up'));
      login.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search); side.appendChild(login);
    }

    const foot = el('div', 'ehm-foot');
    if (me) {
      foot.appendChild(el('div', '', me.full_name + (isAdmin ? ' (' + role + ')' : '')));
      if (isAdmin && !isShop) { const shop = el('a', '', 'View the shop'); shop.href = '/'; foot.appendChild(shop); }
      const out = el('a', '', 'Log out'); out.href = '/'; out.onclick = () => localStorage.removeItem('ehm_token'); foot.appendChild(out);
    }
    if (foot.childNodes.length) side.appendChild(foot);

    const top = el('div', 'ehm-top');
    const burger = el('button', '', '☰'); burger.type = 'button'; burger.setAttribute('aria-label', 'Open menu'); burger.setAttribute('aria-expanded', 'false');
    top.append(burger, el('span', '', 'Emmahenmic'));
    if (isShop) { const c = el('a', ''); c.href = 'cart.html'; c.textContent = 'Cart'; top.appendChild(c); }
    const shade = el('div', 'ehm-shade');
    function toggle(open) { side.classList.toggle('open', open); burger.setAttribute('aria-expanded', String(open)); }
    burger.onclick = () => toggle(!side.classList.contains('open'));
    shade.onclick = () => toggle(false);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });

    document.body.classList.add('ehm-nav');
    document.body.append(top, side, shade);

    // cart numbers follow the browser's saved cart
    const topCart = top.querySelector('a');
    const showCart = () => {
      const n = cartCount();
      cartBadges.forEach(b => { b.textContent = n; b.style.display = n > 0 ? 'inline-block' : 'none'; });
      if (topCart) topCart.textContent = n > 0 ? 'Cart (' + n + ')' : 'Cart';
    };
    showCart(); setInterval(showCart, 800);

    // owner and staff numbers
    if (isAdmin) {
      const counts = async () => {
        if (document.hidden) return;
        try {
          const r = await fetch('/api/admin/summary', { headers: auth });
          if (!r.ok) return;
          const d = await r.json();
          Object.entries(badges).forEach(([k, n]) => { const v = d[k] || 0; n.textContent = v; n.style.display = v > 0 ? 'inline-block' : 'none'; });
        } catch (e) {}
      };
      counts(); setInterval(counts, 30000);
    }
  })();
})();