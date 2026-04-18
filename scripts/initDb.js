// scripts/initDb.js
// Lance ce script une seule fois pour créer la base de données et les données de démo
// Commande : node scripts/initDb.js

const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

const DB_PATH = path.join(__dirname, "..", "data", "cse.db");

// Créer le dossier data si inexistant
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(path.join(__dirname, "..", "uploads"), { recursive: true });

const db = new Database(DB_PATH);

// ─── ACTIVATION WAL pour de meilleures performances ───────────────────────────
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── CRÉATION DES TABLES ──────────────────────────────────────────────────────
db.exec(`
  -- Utilisateurs
  CREATE TABLE IF NOT EXISTS users (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    email     TEXT UNIQUE NOT NULL,
    password  TEXT NOT NULL,
    role      TEXT DEFAULT 'Membre',
    avatar    TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Canaux de messagerie
  CREATE TABLE IF NOT EXISTS channels (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT UNIQUE NOT NULL,
    description TEXT
  );

  -- Messages
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Notes
  CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    content    TEXT,
    status     TEXT DEFAULT 'idee',   -- idee | discussion | validee
    theme      TEXT DEFAULT 'RH',
    author_id  INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Réunions
  CREATE TABLE IF NOT EXISTS meetings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    date        TEXT NOT NULL,
    time        TEXT NOT NULL,
    location    TEXT,
    status      TEXT DEFAULT 'upcoming',  -- upcoming | past | cancelled
    created_by  INTEGER REFERENCES users(id),
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Points de l'ordre du jour
  CREATE TABLE IF NOT EXISTS agenda_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    position   INTEGER DEFAULT 0
  );

  -- Participants aux réunions
  CREATE TABLE IF NOT EXISTS meeting_attendees (
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    status     TEXT DEFAULT 'confirmed',  -- confirmed | declined | pending
    PRIMARY KEY (meeting_id, user_id)
  );

  -- Documents
  CREATE TABLE IF NOT EXISTS documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    filename    TEXT NOT NULL,
    size        INTEGER DEFAULT 0,
    category    TEXT DEFAULT 'Divers',
    icon        TEXT DEFAULT '📄',
    uploaded_by INTEGER REFERENCES users(id),
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ─── DONNÉES DE DÉMONSTRATION ─────────────────────────────────────────────────
console.log("📦 Initialisation de la base de données...");

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (name, email, password, role, avatar)
  VALUES (?, ?, ?, ?, ?)
`);

const users = [
  {
    name: "Rémy Bardet",
    email: "bardet@hotmail.fr",
    password: "azerty",
    role: "Trésorier",
    avatar: "RB",
  },
];

for (const u of users) {
  const hash = bcrypt.hashSync(u.password, 10);
  insertUser.run(u.name, u.email, hash, u.role, u.avatar);
}
console.log("✅ Utilisateurs créés");

// Canaux
db.prepare(
  `INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)`,
).run("general", "Canal général");
db.prepare(
  `INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)`,
).run("activites", "Activités et sorties");
db.prepare(
  `INSERT OR IGNORE INTO channels (name, description) VALUES (?, ?)`,
).run("budget", "Questions budgétaires");
console.log("✅ Canaux créés");

// Messages de démo
const msgs = [
  [1, 4, "Bonjour à tous ! Réunion vendredi à 14h."],
  [1, 2, "Bien reçu, je serai présent."],
  [1, 3, "Moi aussi, merci Lucas !"],
  [2, 2, "On pourrait organiser une sortie karting ?"],
  [2, 3, "Super idée ! Je me renseigne sur les tarifs."],
  [3, 2, "Le bilan du trimestre est disponible."],
];
const insertMsg = db.prepare(
  `INSERT INTO messages (channel_id, user_id, text) VALUES (?, ?, ?)`,
);
for (const [ch, usr, txt] of msgs) insertMsg.run(ch, usr, txt);
console.log("✅ Messages créés");

// Notes
const notesData = [
  [
    "Revalorisation des tickets restaurant",
    "Proposer une augmentation de 2€ par ticket.",
    "idee",
    "RH",
    1,
  ],
  [
    "Mutuelle complémentaire",
    "Étudier les offres du marché pour améliorer la couverture.",
    "discussion",
    "RH",
    2,
  ],
  [
    "Budget fête de fin d'année",
    "Prévoir un budget de 1500€ pour l'événement.",
    "validee",
    "Activités",
    3,
  ],
  [
    "Télétravail 3 jours/semaine",
    "Négocier avec la direction une extension du télétravail.",
    "idee",
    "Conditions",
    4,
  ],
  [
    "Salle de repos",
    "Demander l'aménagement d'un espace détente au 2ème étage.",
    "discussion",
    "Conditions",
    1,
  ],
];
const insertNote = db.prepare(
  `INSERT INTO notes (title, content, status, theme, author_id) VALUES (?, ?, ?, ?, ?)`,
);
for (const n of notesData) insertNote.run(...n);
console.log("✅ Notes créées");

// Réunions
const insertMeeting = db.prepare(
  `INSERT INTO meetings (title, date, time, location, status, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
);
const m1 = insertMeeting.run(
  "Réunion mensuelle Avril",
  "2026-04-18",
  "14:00",
  "Salle Pasteur",
  "upcoming",
  4,
);
const m2 = insertMeeting.run(
  "Réunion extraordinaire",
  "2026-04-25",
  "10:00",
  "Salle de direction",
  "upcoming",
  4,
);
const m3 = insertMeeting.run(
  "Réunion mensuelle Mars",
  "2026-03-21",
  "14:00",
  "Salle Pasteur",
  "past",
  4,
);

const insertAgenda = db.prepare(
  `INSERT INTO agenda_items (meeting_id, content, position) VALUES (?, ?, ?)`,
);
const agenda1 = [
  "Approbation du PV de mars",
  "Point budget Q1",
  "Projet télétravail",
  "Questions diverses",
];
agenda1.forEach((a, i) => insertAgenda.run(m1.lastInsertRowid, a, i));
const agenda2 = [
  "Restructuration des avantages salariés",
  "Nouveau prestataire mutuelle",
];
agenda2.forEach((a, i) => insertAgenda.run(m2.lastInsertRowid, a, i));
const agenda3 = ["Bilan activités Q1", "Préparation fête annuelle", "Divers"];
agenda3.forEach((a, i) => insertAgenda.run(m3.lastInsertRowid, a, i));

const insertAttendee = db.prepare(
  `INSERT OR IGNORE INTO meeting_attendees (meeting_id, user_id) VALUES (?, ?)`,
);
[1, 2, 3, 4].forEach((u) => insertAttendee.run(m1.lastInsertRowid, u));
[1, 4].forEach((u) => insertAttendee.run(m2.lastInsertRowid, u));
[1, 2, 3, 4].forEach((u) => insertAttendee.run(m3.lastInsertRowid, u));
console.log("✅ Réunions créées");

// Documents de démo
const docsData = [
  ["PV Réunion Mars 2026.pdf", "pv_mars_2026.pdf", 250000, "PV", "📄", 1],
  ["Budget CSE 2026.xlsx", "budget_cse_2026.xlsx", 130000, "Budget", "📊", 2],
  [
    "Accord télétravail.pdf",
    "accord_teletravail.pdf",
    320000,
    "Accords",
    "📄",
    4,
  ],
  [
    "Catalogue activités printemps.pdf",
    "catalogue_printemps.pdf",
    1200000,
    "Activités",
    "🎯",
    3,
  ],
  [
    "Règlement intérieur CSE.docx",
    "reglement_interieur.docx",
    91000,
    "Accords",
    "📋",
    4,
  ],
];
const insertDoc = db.prepare(
  `INSERT INTO documents (name, filename, size, category, icon, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)`,
);
for (const d of docsData) insertDoc.run(...d);
console.log("✅ Documents créés");

db.close();
console.log("\n🎉 Base de données initialisée avec succès !");
console.log(`📍 Fichier : ${DB_PATH}`);
console.log("\n👤 Comptes de test :");
users.forEach((u) => console.log(`   ${u.email}  /  motdepasse`));
