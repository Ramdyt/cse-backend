// routes/notes.js
const express = require('express');
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { notifyAll } = require('../notifier');

const router = express.Router();

// Ajouter colonnes si manquantes
try { db.exec(`ALTER TABLE notes ADD COLUMN meeting_id INTEGER REFERENCES meetings(id)`); } catch {}

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
router.get('/', auth, (req, res) => {
  const { theme, status } = req.query;
  let query = NOTE_SELECT;
  const params = [], conditions = [];
  if (theme)  { conditions.push('n.theme = ?');  params.push(theme); }
  if (status) { conditions.push('n.status = ?'); params.push(status); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY n.created_at DESC';
  res.json(db.prepare(query).all(...params).map(mapNote));
});

// POST /api/notes
router.post('/', auth, (req, res) => {
  const { title, content, status = 'proposition', theme, meeting_id } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Titre requis' });
  if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

  const result = db.prepare(
    'INSERT INTO notes (title, content, status, theme, author_id, meeting_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title.trim(), content || '', status, theme || null, req.user.id, meeting_id || null);

  const newNote = db.prepare(NOTE_SELECT + ' WHERE n.id = ?').get(result.lastInsertRowid);
  notifyAll('📝 Nouvelle note', `${req.user.name} a ajouté : "${title.trim()}"`, 'info', '/notes', req.user.id).catch(()=>{});
  res.status(201).json(mapNote(newNote));
});

// PATCH /api/notes/:id
router.patch('/:id', auth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Note introuvable' });

  const { title, content, status, theme, meeting_id } = req.body;
  if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

  db.prepare(`
    UPDATE notes SET
      title      = COALESCE(?, title),
      content    = COALESCE(?, content),
      status     = COALESCE(?, status),
      theme      = COALESCE(?, theme),
      meeting_id = COALESCE(?, meeting_id),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(title || null, content || null, status || null, theme || null, meeting_id || null, req.params.id);

  const updated = db.prepare(NOTE_SELECT + ' WHERE n.id = ?').get(req.params.id);
  if (status) notifyAll('📝 Note mise à jour', `"${updated.title}" → ${status}`, 'info', '/notes', req.user.id).catch(()=>{});
  res.json(mapNote(updated));
});

// DELETE /api/notes/:id
router.delete('/:id', auth, (req, res) => {
  if (!db.prepare('SELECT id FROM notes WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: 'Note introuvable' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
