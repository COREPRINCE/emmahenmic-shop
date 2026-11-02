// Creates emmahenmic.db, builds all the tables, adds sample data,
// then prints every table with how many rows it holds.
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./emmahenmic.db');

const schema = fs.readFileSync('./schema.sql', 'utf8');
const seed = fs.readFileSync('./seed.sql', 'utf8');

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON'); // makes the database enforce links between tables
  db.exec(schema, (err) => {
    if (err) { console.error('Schema error:', err.message); process.exit(1); }
  });
  db.exec(seed, (err) => {
    if (err) { console.error('Seed error:', err.message); process.exit(1); }
  });
  db.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    (err, tables) => {
      if (err) { console.error(err.message); return; }
      console.log('Tables created: ' + tables.length);
      let left = tables.length;
      tables.forEach((t) => {
        db.get('SELECT COUNT(*) AS n FROM ' + t.name, (e, row) => {
          console.log('  ' + t.name + ': ' + row.n + ' rows');
          if (--left === 0) db.close();
        });
      });
    }
  );
});