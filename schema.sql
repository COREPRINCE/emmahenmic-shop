-- EMMAHENMIC SHOP: DATABASE TABLES (SQLite)
-- Money is stored in whole naira (4500 means N4,500).
-- Dates are stored as text like 2026-10-29 12:30:00.

-- 1. DELIVERY ZONES (the owner creates these and sets the fee)
CREATE TABLE IF NOT EXISTS delivery_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  fee INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- 2. USERS (customers, staff and the owner, told apart by "role")
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','staff','owner')),
  job_title TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_active_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. ADDRESSES (a customer can save more than one)
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT,
  address TEXT NOT NULL,
  zone_id INTEGER REFERENCES delivery_zones(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. CATEGORIES
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

-- 5. PRODUCTS (the owner adds these herself)
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL,
  description TEXT,
  nafdac_number TEXT,
  expiry_date TEXT,
  photo_url TEXT,
  unit TEXT NOT NULL DEFAULT 'dozen' CHECK (unit IN ('dozen','carton')),
  base_price INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  min_order INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. BULK PRICES (cheaper price when the customer buys more)
CREATE TABLE IF NOT EXISTS bulk_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  min_qty INTEGER NOT NULL,
  unit_price INTEGER NOT NULL
);

-- 7. ORDERS
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,          -- like EHM-000125
  user_id INTEGER NOT NULL REFERENCES users(id),
  delivery_name TEXT NOT NULL,
  delivery_phone TEXT NOT NULL,
  delivery_address TEXT NOT NULL,
  zone_id INTEGER REFERENCES delivery_zones(id),
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed','packaging','ready','out_for_delivery','delivered','cancelled')),
  driver_name TEXT,
  driver_phone TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8. ORDER ITEMS (unit_price is copied here so old orders never change)
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL
);

-- 9. ORDER STATUS HISTORY (fills the tracking timeline)
CREATE TABLE IF NOT EXISTS order_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 10. PAYMENTS (bank transfer with receipt first, Paystack later)
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL CHECK (method IN ('bank_transfer','paystack')),
  amount INTEGER NOT NULL,
  receipt_photo TEXT,
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','receipt_uploaded','confirmed','failed')),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at TEXT
);

-- 11. STOCK HOLDS (stock kept for a customer while they pay)
CREATE TABLE IF NOT EXISTS stock_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  quantity INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

-- 12. RETURNS (cancel or return requests)
CREATE TABLE IF NOT EXISTS returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('cancel','return')),
  reason TEXT NOT NULL,
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','refunded')),
  reply TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 13. CHAT MESSAGES
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  sender TEXT NOT NULL CHECK (sender IN ('customer','assistant','staff')),
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,          -- has the other side seen this message?
  staff_id INTEGER REFERENCES users(id),       -- which staff member wrote a 'staff' message
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 14. AUDIT LOG (who did what; the code only ever adds rows here)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 15. CONTACT MESSAGES (from the "Send a message" form on the Legal page)
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 16. PROMOTIONS (paid adverts the owner puts in the home page slider; each one expires by itself)
CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  company TEXT,
  tagline TEXT,
  image_url TEXT NOT NULL,
  link_url TEXT,
  starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);