// Sets a new password for any account (the owner, staff or a customer).
//   node reset-password.js someone@example.com TheNewPassword123
// Use a strong password: 12 or more characters, mixing letters, numbers and symbols.
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.log('Usage: node reset-password.js email@example.com new-password-of-8-or-more-characters');
  process.exit(1);
}
const db = new sqlite3.Database('./emmahenmic.db');
db.get('SELECT id, role FROM users WHERE email = ?', [email.toLowerCase()], async (err, user) => {
  if (err) { console.error(err.message); process.exit(1); }
  if (!user) { console.log('No account has that email.'); db.close(); return; }
  const hash = await bcrypt.hash(password, 10);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, user.id], (e) => {
    console.log(e ? e.message : 'Password changed for the ' + user.role + ' account ' + email);
    db.close();
  });
});