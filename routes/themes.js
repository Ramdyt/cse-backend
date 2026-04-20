// routes/themes.js — PostgreSQL
const express = require('express');
const { query, getOne, getAll, insert } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// GET /api/themes
router.get('/', auth, async (req, res) => {
  try {
    const themes = await getAll('SELECT * FROM note_themes ORDER BY name ASC');
    res.json(themes);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/themes
router.post('/', auth, async (req, res) => {
  try {
    const { name, color = '#4f7cff' } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' });
    const existing = await getOne('SELECT id FROM note_themes WHERE name = $1', [name.trim()]);
    if (existing) return res.status(409).json({ error: 'Ce thème existe déjà' });
    const id = await insert('INSERT INTO note_themes (name, color, created_by) VALUES ($1,$2,$3)', [name.trim(), color, req.user.id]);
    res.status(201).json({ id, name: name.trim(), color });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/themes/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const theme = await getOne('SELECT * FROM note_themes WHERE id = $1', [req.params.id]);
    if (!theme) return res.status(404).json({ error: 'Thème introuvable' });
    const { rows } = await query('SELECT COUNT(*) as n FROM notes WHERE theme = $1', [theme.name]);
    const count = parseInt(rows[0].n);
    if (count > 0) return res.status(400).json({ error: `Impossible : ${count} note(s) utilisent ce thème` });
    await query('DELETE FROM note_themes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
