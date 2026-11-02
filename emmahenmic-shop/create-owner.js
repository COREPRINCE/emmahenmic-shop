// Makes the OWNER account (the shop owner's login). Run it once:
//   node create-owner.js "Full Name" email@example.com TheirPassword
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const [name, email, password] = process.argv.slice(2);
if (!name || !email || !password || password.length < 8) {
  console.log('Usage: node create-owner.js "Full Name" email@example.com password-of-8-or-more-characters');
  process.exit(1);
}

const db = new sqlite3.Database('./emmahenmic.db');
db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()], async (err, row) => {
  if (err) { console.error(err.message); process.exit(1); }
  if (row) { console.log('That email already has an account.'); db.close(); return; }
  const hash = await bcrypt.hash(password, 10);
  db.run("INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'owner')",
    [name, email.toLowerCase(), hash], (e) => {
      if (e) console.error(e.message); else console.log('Owner account created for ' + email);
      db.close();
    });
});