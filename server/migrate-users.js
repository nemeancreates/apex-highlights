// ================================
// ONE-TIME MIGRATION — imports existing users.json into SQLite.
// Run once: `node migrate-users.js`
// Safe to run more than once (upsert). Delete after a successful run.
// ================================
const fs = require('fs');
const path = require('path');
const db = require('./db');

const USERS_FILE = path.join(__dirname, 'users.json');

if (!fs.existsSync(USERS_FILE)) {
  console.log('No users.json found — nothing to migrate. (Fresh start is fine.)');
  process.exit(0);
}

const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const upsert = db.prepare(`
  INSERT INTO users (username_lower, username, passwordHash, createdAt)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(username_lower) DO UPDATE SET passwordHash = excluded.passwordHash
`);

const run = db.transaction((list) => {
  let n = 0;
  for (const u of list) {
    if (!u.username || !u.passwordHash) continue;
    upsert.run(
      u.username.toLowerCase(),
      u.username,
      u.passwordHash,
      u.createdAt || new Date().toISOString()
    );
    n++;
  }
  return n;
});

const count = run(raw);
console.log(`Migrated ${count} user(s) from users.json into peakabu.db`);

const total = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
console.log(`Total users in DB now: ${total}`);
