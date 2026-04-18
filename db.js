// db.js — singleton SQLite adapté production/développement
const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

// En production sur Render, la base est dans /data (disque persistant)
// En développement, dans le dossier local data/
const DB_PATH = process.env.NODE_ENV === 'production'
  ? '/data/cse.db'
  : path.join(__dirname, 'data', 'cse.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
