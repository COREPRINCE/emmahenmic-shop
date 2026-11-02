-- SAMPLE DATA FOR TESTING ONLY (the owner replaces these later)
INSERT OR IGNORE INTO delivery_zones (name, fee) VALUES
  ('Lagos Mainland', 2500), ('Lagos Island', 3500), ('Ikeja', 2000);

INSERT OR IGNORE INTO categories (name) VALUES
  ('Makeup'), ('Skincare'), ('Hair care'), ('Fragrance');

INSERT INTO products (category_id, name, description, unit, base_price, stock, min_order)
SELECT c.id, p.name, 'Sample product', p.unit, p.price, p.stock, 1
FROM (
  SELECT 'Makeup' cat, 'Matte lipstick' name, 'dozen' unit, 3500 price, 120 stock UNION ALL
  SELECT 'Makeup', 'Liquid foundation', 'carton', 7500, 40 UNION ALL
  SELECT 'Skincare', 'Shea body butter', 'carton', 4500, 60 UNION ALL
  SELECT 'Hair care', 'Hair growth oil', 'carton', 5000, 80
) p JOIN categories c ON c.name = p.cat
WHERE NOT EXISTS (SELECT 1 FROM products);

INSERT INTO bulk_prices (product_id, min_qty, unit_price)
SELECT id, 10, 3300 FROM products WHERE name = 'Matte lipstick'
AND NOT EXISTS (SELECT 1 FROM bulk_prices);