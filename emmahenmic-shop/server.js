// Emmahenmic shop server, step 2: read-only routes + serves the website from the public folder
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // the site will sit behind a tunnel or host, so use the visitor's real address for the login limiter
app.use(express.json());
app.use(express.static('public')); // serves the website files in the public folder

const db = new sqlite3.Database('./emmahenmic.db');
db.run('PRAGMA foreign_keys = ON');

// The secret that signs the login tokens. If JWT_SECRET is not set, a long random one is made the first time
// the server starts and kept in the file secret.key (next to server.js). Never share or upload that file.
// Deleting it is safe: everyone just has to log in again.
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(__dirname, 'secret.key');
  try { const saved = fs.readFileSync(file, 'utf8').trim(); if (saved.length >= 32) return saved; } catch (e) {}
  const fresh = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}
const JWT_SECRET = loadSecret();

// Small helpers so we can use async/await with the database
const dbGet = (sql, p = []) => new Promise((ok, no) => db.get(sql, p, (e, r) => e ? no(e) : ok(r)));
const dbAll = (sql, p = []) => new Promise((ok, no) => db.all(sql, p, (e, r) => e ? no(e) : ok(r)));
const dbRun = (sql, p = []) => new Promise((ok, no) => db.run(sql, p, function (e) { e ? no(e) : ok(this); }));

// ---------- LOGIN HELPERS ----------
const makeToken = (user) => jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
const publicUser = (u) => ({ id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, role: u.role });

// Middleware: checks the token the browser sends. Use it on any route that needs a logged-in user.
async function requireLogin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch (e) { return res.status(401).json({ error: 'Your login has expired. Please log in again' }); }
  try {
    // Check the account in the database every time, so a switched-off account is locked out at once
    const u = await dbGet('SELECT id, role, is_active FROM users WHERE id = ?', [payload.id]);
    if (!u || !u.is_active) return res.status(401).json({ error: 'This account is not active' });
    req.user = { id: u.id, role: u.role };
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// Middleware: only lets certain roles through. Use it AFTER requireLogin.
// Example: app.get('/api/admin/x', requireLogin, requireRole('owner'), handler)
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'This area is not for your account' });

// Stops someone from guessing passwords: 10 tries per 15 minutes per device
const attempts = new Map();
function tooManyTries(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  recent.push(now);
  attempts.set(ip, recent);
  return recent.length > 10;
}

// GET /api/categories  ->  all categories
app.get('/api/categories', (req, res) => {
  db.all('SELECT id, name FROM categories ORDER BY name', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// A small seeded shuffle (Fisher-Yates with a seeded random number maker)
function shuffleWithSeed(list, seed) {
  let a = seed | 0;
  const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

// GET /api/products?category=Makeup&q=lipstick&limit=24&offset=0
//   -> { products: [...], total }   (small groups, so a shop with 1000+ products stays fast)
app.get('/api/products', async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 60);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const cat = req.query.category || null;
    const text = String(req.query.q || '').trim().slice(0, 60);
    const like = text ? '%' + text.replace(/[\\%_]/g, '\\$&') + '%' : null;
    const where = `p.is_active = 1 AND (? IS NULL OR c.name = ?)
                   AND (? IS NULL OR p.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')`;
    const args = [cat, cat, like, like, like, like];
    // Shuffled view: each visit brings a "seed" number. The same seed always gives the same order, so
    // "Show more" never repeats or skips a product, while a new visit (new seed) shows a new order.
    const seed = parseInt(req.query.seed, 10);
    if (Number.isInteger(seed) && seed > 0 && !text) {
      const ids = (await dbAll(`SELECT p.id FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where} ORDER BY p.id`, args)).map(r => r.id);
      shuffleWithSeed(ids, seed);
      const page = ids.slice(offset, offset + limit);
      if (!page.length) return res.json({ products: [], total: ids.length });
      const found = await dbAll(
        `SELECT p.id, p.name, p.description, p.unit, p.base_price, p.stock, p.min_order, p.photo_url, c.name AS category
         FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id IN (${page.map(() => '?').join(',')})`, page);
      const byId = new Map(found.map(p => [p.id, p]));
      return res.json({ products: page.map(id => byId.get(id)).filter(Boolean), total: ids.length });
    }
    const total = (await dbGet(`SELECT COUNT(*) AS n FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE ${where}`, args)).n;
    const products = await dbAll(
      `SELECT p.id, p.name, p.description, p.unit, p.base_price, p.stock, p.min_order, p.photo_url, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${where} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...args, limit, offset]);
    res.json({ products, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/products/1  ->  one product with its bulk prices
app.get('/api/products/:id', (req, res) => {
  db.get('SELECT * FROM products WHERE id = ? AND is_active = 1', [req.params.id], (err, product) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    db.all('SELECT min_qty, unit_price FROM bulk_prices WHERE product_id = ? ORDER BY min_qty',
      [product.id], (err2, tiers) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ ...product, bulk_prices: tiers });
      });
  });
});

// GET /api/zones  ->  delivery zones that are switched on
app.get('/api/zones', (req, res) => {
  db.all('SELECT id, name, fee FROM delivery_zones WHERE is_active = 1 ORDER BY name', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ---------- SIGNUP / LOGIN ----------
// POST /api/signup  { full_name, email, phone, password }  ->  customer account
app.post('/api/signup', async (req, res) => {
  try {
    const { full_name, email, phone, password } = req.body || {};
    if (!full_name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const mail = email.trim().toLowerCase();
    if (await dbGet('SELECT id FROM users WHERE email = ?', [mail])) {
      return res.status(409).json({ error: 'This email already has an account' });
    }
    const hash = await bcrypt.hash(password, 10);
    // role is ALWAYS customer here. Nobody can make themselves owner from the website.
    const r = await dbRun(
      "INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'customer')",
      [full_name.trim(), mail, phone || null, hash]);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [r.lastID]);
    res.status(201).json({ token: makeToken(user), user: publicUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/login  { email, password }
app.post('/api/login', async (req, res) => {
  try {
    if (tooManyTries(req.ip)) return res.status(429).json({ error: 'Too many tries. Please wait 15 minutes' });
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
    const ok = user && await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong email or password' }); // same message for both on purpose
    if (!user.is_active) return res.status(403).json({ error: 'This account has been switched off. Contact the shop' });

    await dbRun('UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    res.json({ token: makeToken(user), user: publicUser(user) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/me  ->  who is logged in (needs the token)
app.get('/api/me', requireLogin, async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ? AND is_active = 1', [req.user.id]);
    if (!user) return res.status(401).json({ error: 'Account not found' });
    res.json(publicUser(user));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- OWNER / STAFF AREA ----------
// GET /api/admin/summary  ->  shop numbers (owner and staff only)
app.get('/api/admin/summary', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const count = async (sql) => (await dbGet(sql)).n;
    res.json({
      products: await count('SELECT COUNT(*) AS n FROM products WHERE is_active = 1'),
      customers: await count("SELECT COUNT(*) AS n FROM users WHERE role = 'customer'"),
      staff: await count("SELECT COUNT(*) AS n FROM users WHERE role = 'staff'"),
      orders: await count('SELECT COUNT(*) AS n FROM orders'),
      receipts_to_check: await count("SELECT COUNT(*) AS n FROM payments WHERE status = 'receipt_uploaded'"),
      unread_chats: await count("SELECT COUNT(*) AS n FROM chat_messages WHERE sender = 'customer' AND is_read = 0")
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- OWNER: ADD AND MANAGE PRODUCTS ----------
// Photos are saved in public/uploads. Only real images are accepted.
const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    // the file name is made by us, never taken from the user
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + EXT[file.mimetype])
  }),
  fileFilter: (req, file, cb) => EXT[file.mimetype] ? cb(null, true) : cb(new Error('Photo must be a JPG, PNG or WEBP picture')),
  limits: { fileSize: 3 * 1024 * 1024 }
});
const takePhoto = (req, res, next) => upload.single('photo')(req, res, (err) => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Photo is too big (3MB is the limit)' : err.message });
});
const audit = (userId, action, details) =>
  dbRun('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)', [userId, action, details]);

// POST /api/admin/products  (owner only)  form fields + optional photo
app.post('/api/admin/products', requireLogin, requireRole('owner'), takePhoto, async (req, res) => {
  const dropPhoto = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  const fail = (msg) => { dropPhoto(); return res.status(400).json({ error: msg }); };
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    const price = Number(b.base_price);
    const stock = b.stock === '' || b.stock === undefined ? 0 : Number(b.stock);
    const minOrder = b.min_order === '' || b.min_order === undefined ? 1 : Number(b.min_order);
    const unit = b.unit;
    if (!name) return fail('Product name is required');
    if (!Number.isInteger(price) || price <= 0) return fail('Price must be a whole number above 0');
    if (!Number.isInteger(stock) || stock < 0) return fail('Stock must be 0 or more');
    if (!Number.isInteger(minOrder) || minOrder < 1) return fail('Minimum order must be 1 or more');
    if (!['dozen', 'carton'].includes(unit)) return fail('Choose dozen or carton');
    if (b.expiry_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) return fail('Expiry date must look like 2027-06-30');

    // category: pick one, or type a new one
    let categoryId = null;
    const newCat = (b.new_category || '').trim();
    if (newCat) {
      const found = await dbGet('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', [newCat]);
      categoryId = found ? found.id : (await dbRun('INSERT INTO categories (name) VALUES (?)', [newCat])).lastID;
    } else if (b.category_id) {
      const found = await dbGet('SELECT id FROM categories WHERE id = ?', [Number(b.category_id)]);
      if (!found) return fail('That category does not exist');
      categoryId = found.id;
    } else return fail('Choose a category or type a new one');

    // bulk prices: [{min_qty, unit_price}, ...]
    let bulk = [];
    try { bulk = JSON.parse(b.bulk || '[]'); } catch (e) { return fail('Bulk prices were not understood'); }
    bulk = bulk.filter(x => x && x.min_qty !== '' && x.unit_price !== '').map(x => ({ q: Number(x.min_qty), p: Number(x.unit_price) }));
    for (const x of bulk) {
      if (!Number.isInteger(x.q) || x.q < 2 || !Number.isInteger(x.p) || x.p <= 0) return fail('Bulk price rows need a quantity of 2 or more and a price');
      if (x.p >= price) return fail('A bulk price must be lower than the normal price');
    }

    const photoUrl = req.file ? '/uploads/' + req.file.filename : null;
    const r = await dbRun(
      `INSERT INTO products (category_id, name, description, nafdac_number, expiry_date, photo_url, unit, base_price, stock, min_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [categoryId, name, (b.description || '').trim() || null, (b.nafdac_number || '').trim() || null,
       b.expiry_date || null, photoUrl, unit, price, stock, minOrder]);
    for (const x of bulk) await dbRun('INSERT INTO bulk_prices (product_id, min_qty, unit_price) VALUES (?, ?, ?)', [r.lastID, x.q, x.p]);
    await audit(req.user.id, 'product_added', name + ' (id ' + r.lastID + ')');
    res.status(201).json({ id: r.lastID, name });
  } catch (err) { dropPhoto(); res.status(500).json({ error: err.message }); }
});

// GET /api/admin/products?q=lipstick&limit=30&offset=0  ->  { rows, total }  (every product, including hidden ones)
app.get('/api/admin/products', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const text = String(req.query.q || '').trim().slice(0, 60);
    const like = text ? '%' + text.replace(/[\\%_]/g, '\\$&') + '%' : null;
    const from = `FROM products p LEFT JOIN categories c ON c.id = p.category_id
                  WHERE (? IS NULL OR p.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' OR p.nafdac_number LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')`;
    const args = [like, like, like, like, like];
    const total = (await dbGet('SELECT COUNT(*) AS n ' + from, args)).n;
    const rows = await dbAll('SELECT p.id, p.name, p.unit, p.base_price, p.stock, p.is_active, p.photo_url, c.name AS category ' + from + ' ORDER BY p.id DESC LIMIT ? OFFSET ?', [...args, limit, offset]);
    res.json({ rows, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/products/5  { is_active, stock, base_price }  (owner only; send only what changes)
app.patch('/api/admin/products/:id', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const p = await dbGet('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    const sets = [], vals = [], notes = [];
    const { is_active, stock, base_price } = req.body || {};
    if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); notes.push(is_active ? 'shown' : 'hidden'); }
    if (stock !== undefined) {
      if (!Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: 'Stock must be 0 or more' });
      sets.push('stock = ?'); vals.push(stock); notes.push('stock ' + p.stock + ' to ' + stock);
    }
    if (base_price !== undefined) {
      if (!Number.isInteger(base_price) || base_price <= 0) return res.status(400).json({ error: 'Price must be a whole number above 0' });
      sets.push('base_price = ?'); vals.push(base_price); notes.push('price ' + p.base_price + ' to ' + base_price);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
    await dbRun('UPDATE products SET ' + sets.join(', ') + ' WHERE id = ?', [...vals, p.id]);
    await audit(req.user.id, 'product_changed', p.name + ': ' + notes.join(', '));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- ADVERTS / PROMOTIONS (home page slider) ----------
// The table is created here too, so you do not have to run setup-db.js again.
db.run(`CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, company TEXT, tagline TEXT,
  image_url TEXT NOT NULL, link_url TEXT, starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

// GET /api/promotions  ->  adverts running right now (max 5). Expired ones simply stop showing.
app.get('/api/promotions', (req, res) => {
  db.all(`SELECT id, title, company, tagline, image_url, link_url FROM promotions
          WHERE is_active = 1 AND starts_at <= datetime('now') AND expires_at > datetime('now')
          ORDER BY id DESC LIMIT 5`,
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows));
});

// POST /api/admin/promotions  (owner only)  form fields + photo (the photo is required)
app.post('/api/admin/promotions', requireLogin, requireRole('owner'), takePhoto, async (req, res) => {
  const fail = (msg) => { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: msg }); };
  try {
    const b = req.body || {};
    const title = (b.title || '').trim(), company = (b.company || '').trim();
    const tagline = (b.tagline || '').trim(), link = (b.link_url || '').trim();
    const days = Number(b.days || 14);
    if (!title || title.length > 80) return fail('Give the advert a title (up to 80 letters)');
    if (company.length > 60 || tagline.length > 120) return fail('Company name or tagline is too long');
    if (link && !/^https?:\/\//i.test(link)) return fail('The link must start with http:// or https://');
    if (![7, 14, 30].includes(days)) return fail('Choose 7, 14 or 30 days');
    if (!req.file) return fail('Please add the advert picture');
    const running = await dbGet("SELECT COUNT(*) AS n FROM promotions WHERE is_active = 1 AND expires_at > datetime('now')");
    if (running.n >= 5) return fail('You already have 5 adverts running. End one, or wait for one to expire');

    const r = await dbRun(
      `INSERT INTO promotions (title, company, tagline, image_url, link_url, expires_at)
       VALUES (?, ?, ?, ?, ?, datetime('now', ?))`,
      [title, company || null, tagline || null, '/uploads/' + req.file.filename, link || null, '+' + days + ' days']);
    await audit(req.user.id, 'promotion_added', title + (company ? ' (' + company + ')' : '') + ', ' + days + ' days');
    res.status(201).json({ id: r.lastID, title });
  } catch (err) { if (req.file) fs.unlink(req.file.path, () => {}); res.status(500).json({ error: err.message }); }
});

// GET /api/admin/promotions  ->  all adverts with their status (owner and staff)
app.get('/api/admin/promotions', requireLogin, requireRole('owner', 'staff'), (req, res) => {
  db.all(`SELECT id, title, company, tagline, image_url, expires_at,
            CASE WHEN is_active = 0 THEN 'ended' WHEN expires_at <= datetime('now') THEN 'expired' ELSE 'running' END AS status,
            CAST(julianday(expires_at) - julianday('now') AS INTEGER) AS days_left
          FROM promotions ORDER BY id DESC`,
    (err, rows) => err ? res.status(500).json({ error: err.message }) : res.json(rows));
});

// POST /api/admin/promotions/3/end  ->  stop an advert early (owner only)
app.post('/api/admin/promotions/:id/end', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const p = await dbGet('SELECT title FROM promotions WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Advert not found' });
    await dbRun('UPDATE promotions SET is_active = 0 WHERE id = ?', [req.params.id]);
    await audit(req.user.id, 'promotion_ended', p.title);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- CART PRICES AND ORDERS ----------
// The shop's bank details. The owner will be able to change these from her area later.
const BANK = { bank: '[Bank name]', account_name: 'Emmahenmic The Great Business Ent', account_number: '[Account number]' };

// Works out the real price of a cart. The server always calculates this itself,
// so a customer can never change a price by editing the page.
async function priceCart(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 50) return { lines: [], subtotal: 0, errors: ['Your cart is empty'] };
  const merged = new Map();
  for (const it of items) {
    const id = Number(it && it.product_id), q = Number(it && it.quantity);
    if (!Number.isInteger(id) || !Number.isInteger(q) || q < 1 || q > 10000) return { lines: [], subtotal: 0, errors: ['Your cart has an invalid item'] };
    merged.set(id, (merged.get(id) || 0) + q);
  }
  const lines = [], errors = [];
  let subtotal = 0;
  for (const [id, q] of merged) {
    const p = await dbGet('SELECT * FROM products WHERE id = ? AND is_active = 1', [id]);
    if (!p) { lines.push({ product_id: id, name: 'Item no longer available', quantity: q, unit_price: 0, line_total: 0, problem: 'No longer available' }); errors.push('An item in your cart is no longer available'); continue; }
    const tier = await dbGet('SELECT unit_price FROM bulk_prices WHERE product_id = ? AND min_qty <= ? ORDER BY min_qty DESC LIMIT 1', [id, q]);
    const unitPrice = tier && tier.unit_price < p.base_price ? tier.unit_price : p.base_price;
    let problem = null;
    if (q < p.min_order) problem = 'Minimum order is ' + p.min_order;
    else if (q > p.stock) problem = p.stock > 0 ? 'Only ' + p.stock + ' left' : 'Out of stock';
    if (problem) errors.push(p.name + ': ' + problem);
    const line = { product_id: id, name: p.name, unit: p.unit, photo_url: p.photo_url, quantity: q, min_order: p.min_order,
                   stock: p.stock, unit_price: unitPrice, line_total: unitPrice * q, problem };
    subtotal += line.line_total;
    lines.push(line);
  }
  return { lines, subtotal, errors };
}

// POST /api/cart/price  { items: [{product_id, quantity}] }  ->  priced cart
app.post('/api/cart/price', async (req, res) => {
  try { res.json(await priceCart((req.body || {}).items)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orders  (logged in)  { items, zone_id, delivery_name, delivery_phone, delivery_address }
app.post('/api/orders', requireLogin, async (req, res) => {
  const taken = []; // stock we have already taken, so we can give it back if something fails
  const giveBack = async () => { for (const t of taken) await dbRun('UPDATE products SET stock = stock + ? WHERE id = ?', [t.quantity, t.product_id]); };
  try {
    const b = req.body || {};
    const name = (b.delivery_name || '').trim(), phone = (b.delivery_phone || '').replace(/[\s-]/g, ''), address = (b.delivery_address || '').trim();
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter the name of the person receiving the order' });
    if (!/^\+?\d{7,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
    if (address.length < 5 || address.length > 300) return res.status(400).json({ error: 'Enter the full delivery address' });
    const zone = await dbGet('SELECT * FROM delivery_zones WHERE id = ? AND is_active = 1', [Number(b.zone_id)]);
    if (!zone) return res.status(400).json({ error: 'Choose a delivery area' });

    const priced = await priceCart(b.items);
    if (priced.errors.length) return res.status(400).json({ error: priced.errors[0] });

    // take the stock; if someone else bought it first, stop and give back what we took
    for (const line of priced.lines) {
      const r = await dbRun('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', [line.quantity, line.product_id, line.quantity]);
      if (r.changes === 0) { await giveBack(); return res.status(409).json({ error: line.name + ' just ran low. Please check your cart again' }); }
      taken.push(line);
    }

    const total = priced.subtotal + zone.fee;
    const temp = 'TMP-' + Math.random().toString(36).slice(2, 10);
    const o = await dbRun(
      `INSERT INTO orders (order_number, user_id, delivery_name, delivery_phone, delivery_address, zone_id, subtotal, delivery_fee, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [temp, req.user.id, name, phone, address, zone.id, priced.subtotal, zone.fee, total]);
    const number = 'EHM-' + String(o.lastID).padStart(6, '0');
    await dbRun('UPDATE orders SET order_number = ? WHERE id = ?', [number, o.lastID]);
    for (const line of priced.lines)
      await dbRun('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)', [o.lastID, line.product_id, line.quantity, line.unit_price]);
    await dbRun("INSERT INTO order_status_history (order_id, status, changed_by, note) VALUES (?, 'placed', ?, 'Order placed')", [o.lastID, req.user.id]);
    await dbRun("INSERT INTO payments (order_id, method, amount) VALUES (?, 'bank_transfer', ?)", [o.lastID, total]);
    res.status(201).json({ order_number: number, total });
  } catch (err) { await giveBack(); res.status(500).json({ error: err.message }); }
});

// GET /api/orders/EHM-000001  ->  one order (its owner, or staff and the owner of the shop)
app.get('/api/orders/:number', requireLogin, async (req, res) => {
  try {
    const o = await dbGet(
      `SELECT o.*, z.name AS zone_name FROM orders o LEFT JOIN delivery_zones z ON z.id = o.zone_id WHERE o.order_number = ?`, [req.params.number]);
    const allowed = o && (o.user_id === req.user.id || ['owner', 'staff'].includes(req.user.role));
    if (!allowed) return res.status(404).json({ error: 'Order not found' });
    db.all(`SELECT oi.quantity, oi.unit_price, p.name, p.unit FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`, [o.id], async (err, items) => {
      if (err) return res.status(500).json({ error: err.message });
      const payment = await dbGet('SELECT method, amount, status, (receipt_photo IS NOT NULL) AS has_receipt FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [o.id]);
      res.json({ order: o, items, payment, bank: BANK });
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- PAYMENT RECEIPTS ----------
// Receipts are kept OUTSIDE the public folder, so nobody can open one by guessing a web address.
const receiptDir = path.join(__dirname, 'receipts');
fs.mkdirSync(receiptDir, { recursive: true });
const receiptUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, receiptDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + EXT[file.mimetype])
  }),
  fileFilter: (req, file, cb) => EXT[file.mimetype] ? cb(null, true) : cb(new Error('Receipt must be a JPG, PNG or WEBP picture (a screenshot is fine)')),
  limits: { fileSize: 4 * 1024 * 1024 }
});
const takeReceipt = (req, res, next) => receiptUpload.single('receipt')(req, res, (err) => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Picture is too big (4MB is the limit)' : err.message });
});

// POST /api/orders/EHM-000001/receipt  (the customer who placed the order)
app.post('/api/orders/:number/receipt', requireLogin, takeReceipt, async (req, res) => {
  const drop = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  try {
    const o = await dbGet('SELECT * FROM orders WHERE order_number = ? AND user_id = ?', [req.params.number, req.user.id]);
    if (!o) { drop(); return res.status(404).json({ error: 'Order not found' }); }
    if (!req.file) return res.status(400).json({ error: 'Choose a picture of your receipt first' });
    if (o.status === 'cancelled') { drop(); return res.status(400).json({ error: 'This order was cancelled' }); }
    const pay = await dbGet('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [o.id]);
    if (!pay) { drop(); return res.status(404).json({ error: 'Payment record not found' }); }
    if (pay.status === 'confirmed') { drop(); return res.status(400).json({ error: 'This payment is already confirmed' }); }
    await dbRun("UPDATE payments SET receipt_photo = ?, status = 'receipt_uploaded' WHERE id = ?", [req.file.filename, pay.id]);
    await audit(req.user.id, 'receipt_uploaded', o.order_number);
    res.json({ ok: true });
  } catch (err) { drop(); res.status(500).json({ error: err.message }); }
});

// GET /api/orders/EHM-000001/receipt  ->  the picture (its customer, staff, or the owner)
app.get('/api/orders/:number/receipt', requireLogin, async (req, res) => {
  try {
    const o = await dbGet('SELECT * FROM orders WHERE order_number = ?', [req.params.number]);
    const allowed = o && (o.user_id === req.user.id || ['owner', 'staff'].includes(req.user.role));
    if (!allowed) return res.status(404).json({ error: 'Receipt not found' });
    const pay = await dbGet('SELECT receipt_photo FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [o.id]);
    if (!pay || !pay.receipt_photo) return res.status(404).json({ error: 'No receipt uploaded yet' });
    res.set('Cache-Control', 'private, no-store');
    res.sendFile(path.join(receiptDir, path.basename(pay.receipt_photo)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- OWNER / STAFF: MANAGE ORDERS ----------

// Which status an order may move to next. Cancelling is for the owner only.
const NEXT = {
  placed: ['packaging', 'cancelled'], packaging: ['ready', 'cancelled'], ready: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered'], delivered: [], cancelled: []
};

// GET /api/admin/orders?status=placed&q=EHM-0001  ->  list (newest first)
app.get('/api/admin/orders', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const status = NEXT[req.query.status] ? req.query.status : null;
    const like = req.query.q ? '%' + String(req.query.q).trim() + '%' : null;
    const pay = ['waiting', 'receipt_uploaded', 'confirmed', 'failed'].includes(req.query.pay) ? req.query.pay : null;
    const rows = await dbAll(
      `SELECT o.order_number, o.status, o.total, o.delivery_name, o.created_at, p.status AS payment_status
       FROM orders o LEFT JOIN payments p ON p.id = (SELECT MAX(id) FROM payments WHERE order_id = o.id)
       WHERE (? IS NULL OR o.status = ?)
         AND (? IS NULL OR o.order_number LIKE ? OR o.delivery_name LIKE ? OR o.delivery_phone LIKE ?)
         AND (? IS NULL OR p.status = ?)
       ORDER BY o.id DESC LIMIT 200`, [status, status, like, like, like, like, pay, pay]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/orders/EHM-000001  ->  everything about one order
app.get('/api/admin/orders/:number', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const o = await dbGet(
      `SELECT o.*, z.name AS zone_name, u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone
       FROM orders o LEFT JOIN delivery_zones z ON z.id = o.zone_id LEFT JOIN users u ON u.id = o.user_id
       WHERE o.order_number = ?`, [req.params.number]);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const items = await dbAll('SELECT oi.quantity, oi.unit_price, p.name, p.unit FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?', [o.id]);
    const payment = await dbGet('SELECT method, amount, status, approved_at, (receipt_photo IS NOT NULL) AS has_receipt FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [o.id]);
    const history = await dbAll('SELECT h.status, h.note, h.created_at, u.full_name AS by_name FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.order_id = ? ORDER BY h.id', [o.id]);
    res.json({ order: o, items, payment, history, next: NEXT[o.status] || [], role: req.user.role });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/orders/EHM-000001/payment  { action: 'confirm' | 'reject' }  (owner only)
app.post('/api/admin/orders/:number/payment', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const o = await dbGet('SELECT * FROM orders WHERE order_number = ?', [req.params.number]);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    if (o.status === 'cancelled') return res.status(400).json({ error: 'This order was cancelled' });
    const pay = await dbGet('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [o.id]);
    if (!pay) return res.status(404).json({ error: 'Payment record not found' });
    const action = (req.body || {}).action;
    if (action === 'confirm') {
      if (pay.status === 'confirmed') return res.status(400).json({ error: 'Payment is already confirmed' });
      await dbRun("UPDATE payments SET status = 'confirmed', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?", [req.user.id, pay.id]);
      await dbRun('INSERT INTO order_status_history (order_id, status, changed_by, note) VALUES (?, ?, ?, ?)', [o.id, o.status, req.user.id, 'Payment confirmed']);
      await audit(req.user.id, 'payment_confirmed', o.order_number);
    } else if (action === 'reject') {
      if (pay.status !== 'receipt_uploaded') return res.status(400).json({ error: 'There is no receipt to reject' });
      await dbRun("UPDATE payments SET status = 'failed' WHERE id = ?", [pay.id]);
      await dbRun('INSERT INTO order_status_history (order_id, status, changed_by, note) VALUES (?, ?, ?, ?)', [o.id, o.status, req.user.id, 'Receipt rejected, customer can upload again']);
      await audit(req.user.id, 'payment_rejected', o.order_number);
    } else return res.status(400).json({ error: 'Unknown action' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/orders/EHM-000001/status  { status, driver_name, driver_phone }  (owner and staff)
app.post('/api/admin/orders/:number/status', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const o = await dbGet('SELECT * FROM orders WHERE order_number = ?', [req.params.number]);
    if (!o) return res.status(404).json({ error: 'Order not found' });
    const b = req.body || {};
    const to = b.status;
    if (!(NEXT[o.status] || []).includes(to)) return res.status(400).json({ error: 'This order cannot move from "' + o.status + '" to "' + to + '"' });
    if (to === 'cancelled' && req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can cancel an order' });
    if (to !== 'cancelled') {
      const pay = await dbGet('SELECT status FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [o.id]);
      if (!pay || pay.status !== 'confirmed') return res.status(400).json({ error: 'Confirm the payment first' });
    }
    let driverName = o.driver_name, driverPhone = o.driver_phone, note = null;
    if (to === 'out_for_delivery') {
      driverName = (b.driver_name || '').trim(); driverPhone = (b.driver_phone || '').replace(/[\s-]/g, '');
      if (driverName.length < 2) return res.status(400).json({ error: 'Enter the driver or rider name' });
      if (!/^\+?\d{7,15}$/.test(driverPhone)) return res.status(400).json({ error: 'Enter a valid driver phone number' });
      note = 'Driver: ' + driverName + ', ' + driverPhone;
    }
    if (to === 'cancelled') {
      // give the stock back
      const items = await dbAll('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [o.id]);
      for (const it of items) await dbRun('UPDATE products SET stock = stock + ? WHERE id = ?', [it.quantity, it.product_id]);
      const pay = await dbGet('SELECT status FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1', [o.id]);
      note = 'Stock returned' + (pay && pay.status === 'confirmed' ? '. Payment was confirmed, so refund the customer' : '');
    }
    await dbRun('UPDATE orders SET status = ?, driver_name = ?, driver_phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [to, driverName, driverPhone, o.id]);
    await dbRun('INSERT INTO order_status_history (order_id, status, changed_by, note) VALUES (?, ?, ?, ?)', [o.id, to, req.user.id, note]);
    await audit(req.user.id, 'order_' + to, o.order_number);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orders  ->  the logged-in customer's own orders (newest first)
app.get('/api/orders', requireLogin, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT o.order_number, o.status, o.total, o.created_at, p.status AS payment_status
       FROM orders o LEFT JOIN payments p ON p.id = (SELECT MAX(id) FROM payments WHERE order_id = o.id)
       WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 100`, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- OWNER: DELIVERY AREAS ----------
const LAGOS_AREAS = ['Agege', 'Ajeromi-Ifelodun', 'Alimosho', 'Amuwo-Odofin', 'Apapa', 'Badagry', 'Epe', 'Eti-Osa', 'Ibeju-Lekki',
  'Ifako-Ijaiye', 'Ikeja', 'Ikorodu', 'Kosofe', 'Lagos Island', 'Lagos Mainland', 'Mushin', 'Ojo', 'Oshodi-Isolo', 'Shomolu', 'Surulere'];
const cleanFee = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 1000000 ? n : null; };

// GET /api/admin/zones  ->  every area, including hidden ones
app.get('/api/admin/zones', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try { res.json(await dbAll('SELECT id, name, fee, is_active FROM delivery_zones ORDER BY name')); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/zones  { name, fee }  (owner only)
app.post('/api/admin/zones', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const name = ((req.body || {}).name || '').trim(), fee = cleanFee((req.body || {}).fee);
    if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Enter the name of the area (2 to 60 letters)' });
    if (fee === null) return res.status(400).json({ error: 'Delivery price must be a whole number, 0 or more' });
    if (await dbGet('SELECT id FROM delivery_zones WHERE name = ? COLLATE NOCASE', [name])) return res.status(409).json({ error: 'That area is already on the list' });
    const r = await dbRun('INSERT INTO delivery_zones (name, fee, is_active) VALUES (?, ?, 1)', [name, fee]);
    await audit(req.user.id, 'zone_added', name + ', fee ' + fee);
    res.status(201).json({ id: r.lastID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/zones/3  { name, fee, is_active }  (owner only; send only what changes)
app.patch('/api/admin/zones/:id', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const z = await dbGet('SELECT * FROM delivery_zones WHERE id = ?', [req.params.id]);
    if (!z) return res.status(404).json({ error: 'Area not found' });
    const b = req.body || {}, sets = [], vals = [], notes = [];
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (name.length < 2 || name.length > 60) return res.status(400).json({ error: 'Enter the name of the area (2 to 60 letters)' });
      const other = await dbGet('SELECT id FROM delivery_zones WHERE name = ? COLLATE NOCASE AND id != ?', [name, z.id]);
      if (other) return res.status(409).json({ error: 'Another area already has that name' });
      if (name !== z.name) { sets.push('name = ?'); vals.push(name); notes.push('name to ' + name); }
    }
    if (b.fee !== undefined) {
      const fee = cleanFee(b.fee);
      if (fee === null) return res.status(400).json({ error: 'Delivery price must be a whole number, 0 or more' });
      if (fee !== z.fee) { sets.push('fee = ?'); vals.push(fee); notes.push('fee ' + z.fee + ' to ' + fee); }
    }
    if (b.is_active !== undefined) {
      const on = b.is_active ? 1 : 0;
      if (on !== z.is_active) { sets.push('is_active = ?'); vals.push(on); notes.push(on ? 'shown' : 'hidden'); }
    }
    if (!sets.length) return res.json({ ok: true, changed: false });
    await dbRun('UPDATE delivery_zones SET ' + sets.join(', ') + ' WHERE id = ?', [...vals, z.id]);
    await audit(req.user.id, 'zone_changed', z.name + ': ' + notes.join(', '));
    res.json({ ok: true, changed: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/zones/add-lagos  ->  adds the 20 Lagos areas, HIDDEN with price 0, so she sets each price first
app.post('/api/admin/zones/add-lagos', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    let added = 0;
    for (const name of LAGOS_AREAS) {
      if (await dbGet('SELECT id FROM delivery_zones WHERE name = ? COLLATE NOCASE', [name])) continue;
      await dbRun('INSERT INTO delivery_zones (name, fee, is_active) VALUES (?, 0, 0)', [name]);
      added++;
    }
    if (added) await audit(req.user.id, 'zones_lagos_added', added + ' areas');
    res.json({ added });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- OWNER: STAFF ACCOUNTS ----------
const JOBS = ['Warehouse', 'Packing', 'Dispatch rider', 'Other'];

// GET /api/admin/staff  ->  all staff accounts (owner only)
app.get('/api/admin/staff', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    res.json(await dbAll("SELECT id, full_name, email, phone, job_title, is_active, last_active_at, created_at FROM users WHERE role = 'staff' ORDER BY id DESC"));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/staff  { full_name, email, phone, job_title, password }  (owner only)
app.post('/api/admin/staff', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.full_name || '').trim(), email = (b.email || '').trim().toLowerCase(), phone = (b.phone || '').replace(/[\s-]/g, '');
    const job = JOBS.includes(b.job_title) ? b.job_title : 'Other';
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter the staff member\'s full name' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
    if (phone && !/^\+?\d{7,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
    if (!b.password || b.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (await dbGet('SELECT id FROM users WHERE email = ?', [email])) return res.status(409).json({ error: 'This email already has an account' });
    const hash = await bcrypt.hash(b.password, 10);
    const r = await dbRun("INSERT INTO users (full_name, email, phone, password_hash, role, job_title) VALUES (?, ?, ?, ?, 'staff', ?)", [name, email, phone || null, hash, job]);
    await audit(req.user.id, 'staff_added', name + ' (' + email + '), ' + job);
    res.status(201).json({ id: r.lastID });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/staff/4  { is_active, job_title }  (owner only)
app.patch('/api/admin/staff/:id', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const u = await dbGet("SELECT * FROM users WHERE id = ? AND role = 'staff'", [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Staff member not found' });
    const b = req.body || {}, sets = [], vals = [], notes = [];
    if (b.is_active !== undefined) { const on = b.is_active ? 1 : 0; sets.push('is_active = ?'); vals.push(on); notes.push(on ? 'switched on' : 'switched off'); }
    if (b.job_title !== undefined) {
      if (!JOBS.includes(b.job_title)) return res.status(400).json({ error: 'Unknown job' });
      sets.push('job_title = ?'); vals.push(b.job_title); notes.push('job ' + b.job_title);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
    await dbRun('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?', [...vals, u.id]);
    await audit(req.user.id, 'staff_changed', u.full_name + ': ' + notes.join(', '));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/staff/4/password  { password }  ->  owner sets a new password for a staff member
app.post('/api/admin/staff/:id/password', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const u = await dbGet("SELECT * FROM users WHERE id = ? AND role = 'staff'", [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Staff member not found' });
    const pw = (req.body || {}).password || '';
    if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(pw, 10), u.id]);
    await audit(req.user.id, 'staff_password_reset', u.full_name);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- OWNER: EDIT A PRODUCT (details, price, photo, bulk prices) ----------
// GET /api/admin/products/5  ->  everything about one product, so the form can be filled in
app.get('/api/admin/products/:id', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const p = await dbGet('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    p.bulk_prices = await dbAll('SELECT min_qty, unit_price FROM bulk_prices WHERE product_id = ? ORDER BY min_qty', [p.id]);
    res.json(p);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/admin/products/5  (owner only)  same form fields as adding; the photo is optional (a new one replaces the old)
app.put('/api/admin/products/:id', requireLogin, requireRole('owner'), takePhoto, async (req, res) => {
  const dropNew = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  const fail = (msg) => { dropNew(); return res.status(400).json({ error: msg }); };
  try {
    const p = await dbGet('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!p) { dropNew(); return res.status(404).json({ error: 'Product not found' }); }
    const b = req.body || {};
    const name = (b.name || '').trim();
    const price = Number(b.base_price);
    const stock = b.stock === '' || b.stock === undefined ? 0 : Number(b.stock);
    const minOrder = b.min_order === '' || b.min_order === undefined ? 1 : Number(b.min_order);
    if (!name) return fail('Product name is required');
    if (!Number.isInteger(price) || price <= 0) return fail('Price must be a whole number above 0');
    if (!Number.isInteger(stock) || stock < 0) return fail('Stock must be 0 or more');
    if (!Number.isInteger(minOrder) || minOrder < 1) return fail('Minimum order must be 1 or more');
    if (!['dozen', 'carton'].includes(b.unit)) return fail('Choose dozen or carton');
    if (b.expiry_date && !/^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) return fail('Expiry date must look like 2027-06-30');

    let categoryId = null;
    const newCat = (b.new_category || '').trim();
    if (newCat) {
      const found = await dbGet('SELECT id FROM categories WHERE name = ? COLLATE NOCASE', [newCat]);
      categoryId = found ? found.id : (await dbRun('INSERT INTO categories (name) VALUES (?)', [newCat])).lastID;
    } else if (b.category_id) {
      const found = await dbGet('SELECT id FROM categories WHERE id = ?', [Number(b.category_id)]);
      if (!found) return fail('That category does not exist');
      categoryId = found.id;
    } else return fail('Choose a category or type a new one');

    let bulk = [];
    try { bulk = JSON.parse(b.bulk || '[]'); } catch (e) { return fail('Bulk prices were not understood'); }
    bulk = bulk.filter(x => x && x.min_qty !== '' && x.unit_price !== '').map(x => ({ q: Number(x.min_qty), p: Number(x.unit_price) }));
    for (const x of bulk) {
      if (!Number.isInteger(x.q) || x.q < 2 || !Number.isInteger(x.p) || x.p <= 0) return fail('Bulk price rows need a quantity of 2 or more and a price');
      if (x.p >= price) return fail('A bulk price must be lower than the normal price');
    }

    const photoUrl = req.file ? '/uploads/' + req.file.filename : p.photo_url;
    await dbRun(
      `UPDATE products SET category_id = ?, name = ?, description = ?, nafdac_number = ?, expiry_date = ?, photo_url = ?,
         unit = ?, base_price = ?, stock = ?, min_order = ? WHERE id = ?`,
      [categoryId, name, (b.description || '').trim() || null, (b.nafdac_number || '').trim() || null, b.expiry_date || null,
       photoUrl, b.unit, price, stock, minOrder, p.id]);
    await dbRun('DELETE FROM bulk_prices WHERE product_id = ?', [p.id]);
    for (const x of bulk) await dbRun('INSERT INTO bulk_prices (product_id, min_qty, unit_price) VALUES (?, ?, ?)', [p.id, x.q, x.p]);
    // a new photo replaces the old one, so remove the old file
    if (req.file && p.photo_url && p.photo_url.startsWith('/uploads/')) fs.unlink(path.join(uploadDir, path.basename(p.photo_url)), () => {});
    await audit(req.user.id, 'product_edited', name + ' (id ' + p.id + ')');
    res.json({ id: p.id, name });
  } catch (err) { dropNew(); res.status(500).json({ error: err.message }); }
});

// ---------- OWNER: ACTIVITY LOG ----------
// GET /api/admin/audit?q=price&limit=50&offset=0  ->  { rows, total }   (owner only; the log can only be read, never changed)
app.get('/api/admin/audit', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const text = String(req.query.q || '').trim().slice(0, 60);
    const like = text ? '%' + text.replace(/[\\%_]/g, '\\$&') + '%' : null;
    const from = `FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                  WHERE (? IS NULL OR a.action LIKE ? ESCAPE '\\' OR a.details LIKE ? ESCAPE '\\' OR u.full_name LIKE ? ESCAPE '\\')`;
    const args = [like, like, like, like];
    const total = (await dbGet('SELECT COUNT(*) AS n ' + from, args)).n;
    const rows = await dbAll('SELECT a.id, a.action, a.details, a.created_at, u.full_name AS who, u.role AS role ' + from + ' ORDER BY a.id DESC LIMIT ? OFFSET ?', [...args, limit, offset]);
    res.json({ rows, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- CHAT ----------
// Older databases get the two new chat columns added once, automatically.
db.all('PRAGMA table_info(chat_messages)', (err, cols) => {
  if (err || !cols) return;
  if (!cols.some(c => c.name === 'is_read')) db.run('ALTER TABLE chat_messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0');
  if (!cols.some(c => c.name === 'staff_id')) db.run('ALTER TABLE chat_messages ADD COLUMN staff_id INTEGER');
});

const FAQ = [
  [/(^|\W)(hi|hello|hey|good (morning|afternoon|evening))(\W|$)/, 'Hello! How can we help you today? You can ask about delivery, payment, prices or your order.'],
  [/deliver|shipping/, 'Delivery is charged by area. You choose your area at checkout, and the delivery fee is added to your total before you place the order.'],
  [/pay|transfer|bank|receipt|account (no|number)/, 'You pay by bank transfer after placing your order. The bank details are on your order page, where you can also upload your receipt.'],
  [/minimum|bulk|discount|wholesale|cheaper|carton|dozen/, 'Each product shows its minimum order. When you buy more, the bulk price is applied automatically in your cart.'],
  [/track|status|where is my|my order|order number|ehm-/, 'Open "My orders" at the top of the shop to see the status of every order you placed.'],
  [/cancel|return|refund|wrong item|damaged/, 'Please tell us your order number and what went wrong. A team member will look at it and reply here.']
];
const faqReply = (text) => { const t = String(text).toLowerCase(); const hit = FAQ.find(([re]) => re.test(t)); return hit ? hit[1] : null; };

const chatTimes = new Map();
const chatTooFast = (uid) => {
  const now = Date.now(), recent = (chatTimes.get(uid) || []).filter(t => now - t < 60000);
  recent.push(now); chatTimes.set(uid, recent);
  return recent.length > 20;
};
const customersOnly = requireRole('customer');

// GET /api/chat  ->  this customer's conversation (and marks the shop's replies as read)
app.get('/api/chat', requireLogin, customersOnly, async (req, res) => {
  try {
    const rows = await dbAll('SELECT id, sender, message, created_at FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT 100', [req.user.id]);
    await dbRun("UPDATE chat_messages SET is_read = 1 WHERE user_id = ? AND sender != 'customer' AND is_read = 0", [req.user.id]);
    res.json({ messages: rows.reverse() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/chat/unread  ->  how many replies the customer has not read yet
app.get('/api/chat/unread', requireLogin, customersOnly, async (req, res) => {
  try {
    res.json({ unread: (await dbGet("SELECT COUNT(*) AS n FROM chat_messages WHERE user_id = ? AND sender != 'customer' AND is_read = 0", [req.user.id])).n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/chat  { message }  ->  saves it, and adds an automatic reply when we can answer it
app.post('/api/chat', requireLogin, customersOnly, async (req, res) => {
  try {
    const text = String((req.body || {}).message || '').trim();
    if (!text) return res.status(400).json({ error: 'Type a message first' });
    if (text.length > 500) return res.status(400).json({ error: 'Message is too long (500 letters at most)' });
    if (chatTooFast(req.user.id)) return res.status(429).json({ error: 'You are sending messages too fast. Please wait a moment' });
    await dbRun("INSERT INTO chat_messages (user_id, sender, message) VALUES (?, 'customer', ?)", [req.user.id, text]);
    let reply = faqReply(text);
    if (!reply) {
      // no automatic answer: say a team member will reply, but not again and again
      const last = await dbGet("SELECT created_at FROM chat_messages WHERE user_id = ? AND sender != 'customer' ORDER BY id DESC LIMIT 1", [req.user.id]);
      const stale = !last || (await dbGet("SELECT (julianday('now') - julianday(?)) AS d", [last.created_at])).d > 0.25;
      if (stale) reply = 'Thanks for your message. A team member will reply here soon. You can come back to this chat any time to read the answer.';
    }
    if (reply) await dbRun("INSERT INTO chat_messages (user_id, sender, message) VALUES (?, 'assistant', ?)", [req.user.id, reply]);
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/chats  ->  all conversations, with unread counts (owner and staff)
app.get('/api/admin/chats', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    res.json(await dbAll(
      `SELECT u.id, u.full_name,
         (SELECT message FROM chat_messages WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS last_message,
         (SELECT created_at FROM chat_messages WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS last_at,
         (SELECT COUNT(*) FROM chat_messages WHERE user_id = u.id AND sender = 'customer' AND is_read = 0) AS unread
       FROM users u WHERE EXISTS (SELECT 1 FROM chat_messages WHERE user_id = u.id) ORDER BY last_at DESC LIMIT 100`));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/chats/12  ->  one conversation (marks the customer's messages as read)
app.get('/api/admin/chats/:userId', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const u = await dbGet("SELECT id, full_name, phone FROM users WHERE id = ? AND role = 'customer'", [req.params.userId]);
    if (!u) return res.status(404).json({ error: 'Customer not found' });
    const rows = await dbAll(
      `SELECT m.id, m.sender, m.message, m.created_at, s.full_name AS staff_name FROM chat_messages m
       LEFT JOIN users s ON s.id = m.staff_id WHERE m.user_id = ? ORDER BY m.id DESC LIMIT 200`, [u.id]);
    await dbRun("UPDATE chat_messages SET is_read = 1 WHERE user_id = ? AND sender = 'customer' AND is_read = 0", [u.id]);
    res.json({ customer: u, messages: rows.reverse() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/chats/12  { message }  ->  a staff or owner reply
app.post('/api/admin/chats/:userId', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const u = await dbGet("SELECT id FROM users WHERE id = ? AND role = 'customer'", [req.params.userId]);
    if (!u) return res.status(404).json({ error: 'Customer not found' });
    const text = String((req.body || {}).message || '').trim();
    if (!text) return res.status(400).json({ error: 'Type a reply first' });
    if (text.length > 1000) return res.status(400).json({ error: 'Reply is too long (1000 letters at most)' });
    await dbRun("INSERT INTO chat_messages (user_id, sender, message, staff_id) VALUES (?, 'staff', ?, ?)", [u.id, text, req.user.id]);
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- OWNER: DASHBOARD, REPORTS AND STOCK (how the company is doing) ----------
// Revenue means CONFIRMED payments on orders that were not cancelled, counted on the day the owner confirmed them.
// Shop days follow Lagos time (UTC+1), so "today" starts at midnight in Lagos.
const LOW_STOCK = 10;                                    // this many or fewer left = "low stock"
const DAY = (col) => `date(${col}, '+1 hours')`;
const PAID = `p.status = 'confirmed' AND o.status != 'cancelled'`;
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const lagosToday = async () => (await dbGet("SELECT date('now', '+1 hours') AS d")).d;

// GET /api/admin/dashboard  ->  everything the owner's home screen shows
app.get('/api/admin/dashboard', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const today = await lagosToday();
    const revenue_today = (await dbGet(`SELECT COALESCE(SUM(p.amount), 0) AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${PAID} AND ${DAY('p.approved_at')} = ?`, [today])).n;
    const orders_today = (await dbGet(`SELECT COUNT(*) AS n FROM orders o WHERE o.status != 'cancelled' AND ${DAY('o.created_at')} = ?`, [today])).n;
    const awaiting = (await dbGet("SELECT COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.status = 'receipt_uploaded' AND o.status != 'cancelled'")).n;
    const low_count = (await dbGet('SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND stock <= ?', [LOW_STOCK])).n;
    const week = await dbAll(`SELECT ${DAY('p.approved_at')} AS d, SUM(p.amount) AS n FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${PAID} AND ${DAY('p.approved_at')} >= ? GROUP BY d`, [addDays(today, -6)]);
    const byDate = new Map(week.map(r => [r.d, r.n]));
    const sales_7d = [];
    for (let i = 6; i >= 0; i--) { const d = addDays(today, -i); sales_7d.push({ date: d, revenue: byDate.get(d) || 0 }); }
    const top_products = await dbAll(
      `SELECT pr.name, pr.unit, SUM(oi.quantity) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
       JOIN payments p ON p.order_id = o.id JOIN products pr ON pr.id = oi.product_id
       WHERE ${PAID} AND ${DAY('p.approved_at')} >= ? GROUP BY pr.id ORDER BY qty DESC LIMIT 5`, [today.slice(0, 8) + '01']);
    const approvals = await dbAll(
      `SELECT o.order_number, o.delivery_name, o.total FROM payments p JOIN orders o ON o.id = p.order_id
       WHERE p.status = 'receipt_uploaded' AND o.status != 'cancelled' ORDER BY p.id DESC LIMIT 5`);
    const recent_orders = await dbAll('SELECT order_number, delivery_name, total, status FROM orders ORDER BY id DESC LIMIT 5');
    const low_stock = await dbAll('SELECT name, unit, stock FROM products WHERE is_active = 1 AND stock <= ? ORDER BY stock ASC, name LIMIT 5', [LOW_STOCK]);
    res.json({ today, revenue_today, orders_today, awaiting, low_count, low_limit: LOW_STOCK, sales_7d, top_products, approvals, recent_orders, low_stock });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/reports?range=today|7d|month|custom&from=2026-10-01&to=2026-10-31
app.get('/api/admin/reports', requireLogin, requireRole('owner'), async (req, res) => {
  try {
    const today = await lagosToday();
    let range = req.query.range, from, to;
    if (range === 'today') { from = to = today; }
    else if (range === 'month') { from = today.slice(0, 8) + '01'; to = today; }
    else if (range === 'custom') {
      from = req.query.from; to = req.query.to;
      if (!isDate(from) || !isDate(to)) return res.status(400).json({ error: 'Choose a start date and an end date' });
      if (from > to) return res.status(400).json({ error: 'The start date must be before the end date' });
      if (addDays(from, 366) < to) return res.status(400).json({ error: 'Please choose a period of one year or less' });
    } else { range = '7d'; from = addDays(today, -6); to = today; }

    const paidIn = `${PAID} AND ${DAY('p.approved_at')} BETWEEN ? AND ?`;
    const money = await dbGet(`SELECT COALESCE(SUM(p.amount), 0) AS revenue, COUNT(*) AS paid FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${paidIn}`, [from, to]);
    const orders = (await dbGet(`SELECT COUNT(*) AS n FROM orders o WHERE o.status != 'cancelled' AND ${DAY('o.created_at')} BETWEEN ? AND ?`, [from, to])).n;
    const customers = (await dbGet(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer' AND ${DAY('created_at')} BETWEEN ? AND ?`, [from, to])).n;

    const monthly = addDays(from, 62) < to;      // long periods are shown month by month
    const grouped = await dbAll(
      `SELECT ${monthly ? "strftime('%Y-%m', date(p.approved_at, '+1 hours'))" : DAY('p.approved_at')} AS k, SUM(p.amount) AS n
       FROM payments p JOIN orders o ON o.id = p.order_id WHERE ${paidIn} GROUP BY k ORDER BY k`, [from, to]);
    const found = new Map(grouped.map(r => [r.k, r.n]));
    const by_day = [];
    if (monthly) grouped.forEach(r => by_day.push({ label: r.k, revenue: r.n }));
    else for (let d = from; d <= to; d = addDays(d, 1)) by_day.push({ label: d, revenue: found.get(d) || 0 });

    const best_sellers = await dbAll(
      `SELECT pr.name, pr.unit, SUM(oi.quantity) AS qty, SUM(oi.quantity * oi.unit_price) AS value
       FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN payments p ON p.order_id = o.id JOIN products pr ON pr.id = oi.product_id
       WHERE ${paidIn} GROUP BY pr.id ORDER BY qty DESC LIMIT 10`, [from, to]);
    const by_area = await dbAll(
      `SELECT COALESCE(z.name, 'No area') AS area, SUM(p.amount) AS revenue, COUNT(*) AS orders
       FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN delivery_zones z ON z.id = o.zone_id
       WHERE ${paidIn} GROUP BY area ORDER BY revenue DESC LIMIT 10`, [from, to]);
    res.json({ range, from, to, monthly, revenue: money.revenue, paid_orders: money.paid, orders, customers,
      average: money.paid ? Math.round(money.revenue / money.paid) : 0, by_day, best_sellers, by_area });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/stock?q=&low=1&limit=30&offset=0  ->  { rows, total }  lowest stock first (owner and staff)
app.get('/api/admin/stock', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const text = String(req.query.q || '').trim().slice(0, 60);
    const like = text ? '%' + text.replace(/[\\%_]/g, '\\$&') + '%' : null;
    const lowOnly = req.query.low === '1' ? 1 : 0;
    const from = `FROM products p LEFT JOIN categories c ON c.id = p.category_id
                  WHERE p.is_active = 1 AND (? IS NULL OR p.name LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\') AND (? = 0 OR p.stock <= ?)`;
    const args = [like, like, like, lowOnly, LOW_STOCK];
    const total = (await dbGet('SELECT COUNT(*) AS n ' + from, args)).n;
    const rows = await dbAll('SELECT p.id, p.name, p.unit, p.stock, c.name AS category ' + from + ' ORDER BY p.stock ASC, p.name LIMIT ? OFFSET ?', [...args, limit, offset]);
    res.json({ rows, total, low_limit: LOW_STOCK });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/admin/stock/5  { stock }  ->  set the stock number (owner and staff; saved in the activity log)
app.post('/api/admin/stock/:id', requireLogin, requireRole('owner', 'staff'), async (req, res) => {
  try {
    const stock = Number((req.body || {}).stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) return res.status(400).json({ error: 'Stock must be a whole number, 0 or more' });
    const p = await dbGet('SELECT id, name, stock FROM products WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Product not found' });
    if (p.stock !== stock) {
      await dbRun('UPDATE products SET stock = ? WHERE id = ?', [stock, p.id]);
      await audit(req.user.id, 'stock_updated', p.name + ': ' + p.stock + ' to ' + stock);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(3000, () => console.log('Emmahenmic server running on http://localhost:3000'));
