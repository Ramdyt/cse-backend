// routes/themes.js — Thèmes des notes (créables et supprimables par tous)
const express = require('express');
const db      = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS note_themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT DEFAULT '#4f7cff',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO note_themes (name, color) VALUES ('RH', '#4f7cff');
  INSERT OR IGNORE INTO note_themes (name, color) VALUES ('Activités', '#3ecf8e');
  INSERT OR IGNORE INTO note_themes (name, color) VALUES ('Conditions', '#f5a623');
`);

// GET /api/themes
router.get('/', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM note_themes ORDER BY name ASC').all());
});

// POST /api/themes — tous les membres
router.post('/', auth, (req, res) => {
  const { name, color = '#4f7cff' } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
  if (db.prepare('SELECT id FROM note_themes WHERE name = ?').get(name.trim()))
    return res.status(409).json({ error: 'Ce thème existe déjà' });
  const result = db.prepare('INSERT INTO note_themes (name, color, created_by) VALUES (?, ?, ?)').run(name.trim(), color, req.user.id);
  res.status(201).json({ id: result.lastInsertRowid, name: name.trim(), color });
});

// DELETE /api/themes/:id — tous les membres
router.delete('/:id', auth, (req, res) => {
  const theme = db.prepare('SELECT * FROM note_themes WHERE id = ?').get(req.params.id);
  if (!theme) return res.status(404).json({ error: 'Thème introuvable' });
  const count = db.prepare('SELECT COUNT(*) as n FROM notes WHERE theme = ?').get(theme.name);
  if (count.n > 0) return res.status(400).json({ error: `Impossible : ${count.n} note(s) utilisent ce thème` });
  db.prepare('DELETE FROM note_themes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
