// routes/notes.js — PostgreSQL
const express = require('express');
const { query, getOne, getAll, insert } = require('../db');
const { auth } = require('../middleware/auth');
const { notifyAll } = require('../notifier');

const router = express.Router();

const NOTE_SELECT = `
  SELECT n.id, n.title, n.content, n.status, n.theme, n.meeting_id,
         n.created_at, n.updated_at,
         u.id as author_id, u.name as author_name, u.avatar,
         m.title as meeting_title
  FROM notes n
  JOIN users u ON u.id = n.author_id
  LEFT JOIN meetings m ON m.id = n.meeting_id
`;

const VALID_STATUS = ['proposition', 'discussion', 'validee', 'refusee'];

function mapNote(n) {
  return {
    id: n.id, title: n.title, content: n.content,
    status: n.status, theme: n.theme, meeting_id: n.meeting_id,
    meeting_title: n.meeting_title,
    created_at: n.created_at, updated_at: n.updated_at,
    author: { id: n.author_id, name: n.author_name, avatar: n.avatar },
  };
}

// GET /api/notes
router.get('/', auth, async (req, res) => {
  try {
    const { theme, status } = req.query;
    const conditions = [], params = [];
    if (theme)  { params.push(theme);  conditions.push(`n.theme = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`n.status = $${params.length}`); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const notes = await getAll(NOTE_SELECT + where + ' ORDER BY n.created_at DESC', params);
    res.json(notes.map(mapNote));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/notes
router.post('/', auth, async (req, res) => {
  try {
    const { title, content, status = 'proposition', theme, meeting_id } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'Titre requis' });
    if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

    const id = await insert(
      'INSERT INTO notes (title, content, status, theme, author_id, meeting_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [title.trim(), content || '', status, theme || null, req.user.id, meeting_id || null]
    );
    const newNote = await getOne(NOTE_SELECT + ' WHERE n.id = $1', [id]);
    notifyAll('📝 Nouvelle note', `${req.user.name} a ajouté : "${title.trim()}"`, 'info', '/notes', req.user.id).catch(() => {});
    res.status(201).json(mapNote(newNote));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/notes/:id
router.patch('/:id', auth, async (req, res) => {
  try {
    const note = await getOne('SELECT * FROM notes WHERE id = $1', [req.params.id]);
    if (!note) return res.status(404).json({ error: 'Note introuvable' });

    const { title, content, status, theme, meeting_id } = req.body;
    if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

    await query(`
      UPDATE notes SET
        title      = COALESCE($1, title),
        content    = COALESCE($2, content),
        status     = COALESCE($3, status),
        theme      = COALESCE($4, theme),
        meeting_id = COALESCE($5, meeting_id),
        updated_at = NOW()
      WHERE id = $6
    `, [title || null, content ?? null, status || null, theme || null, meeting_id || null, req.params.id]);

    const updated = await getOne(NOTE_SELECT + ' WHERE n.id = $1', [req.params.id]);
    if (status) notifyAll('📝 Note mise à jour', `"${updated.title}" → ${status}`, 'info', '/notes', req.user.id).catch(() => {});
    res.json(mapNote(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/notes/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const note = await getOne('SELECT id FROM notes WHERE id = $1', [req.params.id]);
    if (!note) return res.status(404).json({ error: 'Note introuvable' });
    await query('DELETE FROM notes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
