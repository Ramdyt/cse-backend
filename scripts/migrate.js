// scripts/migrate.js — Migration base existante
// Lance : node scripts/migrate.js
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data', 'cse.db'));
db.pragma('foreign_keys = OFF');

console.log('🔄 Migration de la base de données...');

const migrations = [
  ["ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0",   "Colonne is_admin"],
  ["ALTER TABLE users ADD COLUMN titulaire INTEGER DEFAULT 1",  "Colonne titulaire"],
  ["ALTER TABLE users ADD COLUMN pending INTEGER DEFAULT 0",    "Colonne pending"],
  ["ALTER TABLE notes ADD COLUMN meeting_id INTEGER",           "Colonne meeting_id"],
  [`UPDATE notes SET status = 'proposition' WHERE status = 'idee'`, "Statut idee → proposition"],
  [`UPDATE notes SET status = 'refusee' WHERE status NOT IN ('proposition','discussion','validee','refusee')`, "Nettoyage statuts"],
  // Premier utilisateur devient admin
  ["UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users WHERE role = 'Président' OR id = 1)", "Admin initial"],
  // Thèmes
  [`CREATE TABLE IF NOT EXISTS note_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT DEFAULT '#4f7cff',
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`, "Table note_themes"],
  ["INSERT OR IGNORE INTO note_themes (name, color) VALUES ('RH', '#4f7cff')",         "Thème RH"],
  ["INSERT OR IGNORE INTO note_themes (name, color) VALUES ('Activités', '#3ecf8e')",   "Thème Activités"],
  ["INSERT OR IGNORE INTO note_themes (name, color) VALUES ('Conditions', '#f5a623')",  "Thème Conditions"],
];

for (const [sql, label] of migrations) {
  try {
    db.prepare(sql).run();
    console.log(`  ✅ ${label}`);
  } catch (e) {
    if (e.message.includes('duplicate column') || e.message.includes('already exists')) {
      console.log(`  ⏭  ${label} (déjà fait)`);
    } else {
      console.log(`  ⚠️  ${label} : ${e.message}`);
    }
  }
}

// Afficher le premier admin
const admin = db.prepare('SELECT name, email FROM users WHERE is_admin = 1').get();
if (admin) console.log(`\n👑 Compte admin : ${admin.name} (${admin.email})`);
else console.log('\n⚠️  Aucun admin trouvé, définissez is_admin=1 manuellement');

db.pragma('foreign_keys = ON');
db.close();
console.log('\n✅ Migration terminée !');

// Nouvelles tables délégation (si pas déjà présentes)
const newTables = [
  [`ALTER TABLE delegation_config ADD COLUMN rh_email TEXT DEFAULT ''`, 'delegation_config.rh_email'],
  [`ALTER TABLE delegation_config ADD COLUMN smtp_host TEXT DEFAULT ''`, 'delegation_config.smtp_host'],
  [`ALTER TABLE delegation_config ADD COLUMN smtp_port INTEGER DEFAULT 587`, 'delegation_config.smtp_port'],
  [`ALTER TABLE delegation_config ADD COLUMN smtp_user TEXT DEFAULT ''`, 'delegation_config.smtp_user'],
  [`ALTER TABLE delegation_config ADD COLUMN smtp_pass TEXT DEFAULT ''`, 'delegation_config.smtp_pass'],
  [`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT,
    type TEXT DEFAULT 'info',
    read INTEGER DEFAULT 0,
    link TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`, 'table notifications'],
];
for (const [sql, label] of newTables) {
  try { db.prepare(sql).run(); console.log(`  ✅ ${label}`); }
  catch (e) { console.log(`  ⏭  ${label} (${e.message.includes('duplicate')||e.message.includes('already')?'déjà fait':e.message})`); }
}
