// scripts/diagnose.js — Diagnostic de la base de données
// Lance : node scripts/diagnose.js
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'cse.db');
console.log(`\n📁 Base de données : ${DB_PATH}`);

let db;
try {
  db = new Database(DB_PATH);
} catch(e) {
  console.error('❌ Impossible d\'ouvrir la base :', e.message);
  process.exit(1);
}

console.log('\n─── COLONNES TABLE users ─────────────────────────────');
const cols = db.prepare("PRAGMA table_info(users)").all();
cols.forEach(c => console.log(`  ${c.name} (${c.type}) default=${c.dflt_value}`));

console.log('\n─── MEMBRES ──────────────────────────────────────────');
try {
  const users = db.prepare('SELECT id, name, email, role, is_admin, titulaire, pending FROM users').all();
  if (users.length === 0) console.log('  ⚠️  Aucun membre en base !');
  users.forEach(u => console.log(`  #${u.id} ${u.name} | role=${u.role} | admin=${u.is_admin} | titulaire=${u.titulaire} | pending=${u.pending}`));
} catch(e) {
  console.log('  ❌ Erreur:', e.message);
}

console.log('\n─── CONFIG DÉLÉGATION ────────────────────────────────');
try {
  const cfg = db.prepare('SELECT * FROM delegation_config').get();
  if (cfg) {
    console.log(`  heures_titulaire : ${cfg.hours_titulaire}`);
    console.log(`  heures_suppleant : ${cfg.hours_suppleant}`);
    console.log(`  max_report       : ${cfg.max_report}`);
    console.log(`  rh_email         : ${cfg.rh_email || '(non configuré)'}`);
    console.log(`  smtp_host        : ${cfg.smtp_host || '(non configuré)'}`);
    console.log(`  smtp_user        : ${cfg.smtp_user || '(non configuré)'}`);
  } else {
    console.log('  ⚠️  Table delegation_config vide');
  }
} catch(e) { console.log('  ❌', e.message); }

console.log('\n─── TABLES PRÉSENTES ─────────────────────────────────');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
tables.forEach(t => console.log(`  ✅ ${t.name}`));

console.log('\n─── SOLUTION si titulaire/pending manquent ───────────');
try {
  db.exec("ALTER TABLE users ADD COLUMN titulaire INTEGER DEFAULT 1");
  console.log('  ✅ Colonne titulaire ajoutée');
} catch { console.log('  ✅ Colonne titulaire déjà présente'); }
try {
  db.exec("ALTER TABLE users ADD COLUMN pending INTEGER DEFAULT 0");
  console.log('  ✅ Colonne pending ajoutée');
} catch { console.log('  ✅ Colonne pending déjà présente'); }
try {
  db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
  console.log('  ✅ Colonne is_admin ajoutée');
} catch { console.log('  ✅ Colonne is_admin déjà présente'); }

// Définir le premier user comme admin
try {
  db.prepare("UPDATE users SET is_admin=1, pending=0 WHERE id=(SELECT MIN(id) FROM users)").run();
  const admin = db.prepare("SELECT name FROM users WHERE is_admin=1").get();
  console.log(`\n  👑 Admin : ${admin?.name || '(aucun)'}`);
} catch(e) { console.log('  ⚠️', e.message); }

db.close();
console.log('\n✅ Diagnostic terminé — relance npm start\n');
