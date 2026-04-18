// routes/meetings.js
const express = require('express');
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { notifyAll } = require('../notifier');

const router = express.Router();

// Migration douce — colonne replacement_id dans meeting_attendees
try { db.exec('ALTER TABLE meeting_attendees ADD COLUMN replacement_id INTEGER'); } catch {}

function hydrateMeeting(meeting) {
  const agenda = db.prepare(
    'SELECT id, content, position FROM agenda_items WHERE meeting_id = ? ORDER BY position'
  ).all(meeting.id);
  const attendees = db.prepare(`
    SELECT u.id, u.name, u.role, u.avatar, u.titulaire,
           ma.status as attendance, ma.replacement_id
    FROM meeting_attendees ma JOIN users u ON u.id = ma.user_id
    WHERE ma.meeting_id = ?
    ORDER BY u.titulaire DESC, u.name ASC
  `).all(meeting.id);
  return { ...meeting, agenda, attendees };
}

// GET /api/meetings
router.get('/', auth, (req, res) => {
  const meetings = db.prepare('SELECT * FROM meetings ORDER BY date DESC, time DESC').all();
  res.json(meetings.map(hydrateMeeting));
});

// GET /api/meetings/:id
router.get('/:id', auth, (req, res) => {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Réunion introuvable' });
  res.json(hydrateMeeting(meeting));
});

// POST /api/meetings — ajoute automatiquement tous les membres actifs
router.post('/', auth, (req, res) => {
  const { title, date, time, location, agenda = [], attendees = [] } = req.body;
  if (!title?.trim() || !date || !time)
    return res.status(400).json({ error: 'Titre, date et heure requis' });

  const status = new Date(date) < new Date() ? 'past' : 'upcoming';
  const result = db.prepare(
    'INSERT INTO meetings (title, date, time, location, status, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title.trim(), date, time, location || '', status, req.user.id);

  const meetingId = result.lastInsertRowid;

  // Ordre du jour
  const insertAgenda = db.prepare('INSERT INTO agenda_items (meeting_id, content, position) VALUES (?, ?, ?)');
  agenda.forEach((item, i) => { if (item?.trim()) insertAgenda.run(meetingId, item.trim(), i); });

  // Ajouter TOUS les membres actifs (non pending) en ❓ À confirmer par défaut
  const allUsers = db.prepare('SELECT id FROM users WHERE pending = 0').all();
  const insertAttendee = db.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, user_id, status) VALUES (?, ?, ?)');
  allUsers.forEach(u => insertAttendee.run(meetingId, u.id, 'pending'));

  // Si des attendees spécifiques ont été passés, les mettre en confirmed
  if (attendees.length > 0) {
    const updateAttendee = db.prepare('UPDATE meeting_attendees SET status = ? WHERE meeting_id = ? AND user_id = ?');
    attendees.forEach(uid => updateAttendee.run('confirmed', meetingId, Number(uid)));
  }

  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  notifyAll('📅 Nouvelle réunion', `${title.trim()} — ${date} à ${time}`, 'info', '/meetings', req.user.id).catch(()=>{});
  res.status(201).json(hydrateMeeting(meeting));
});

// PATCH /api/meetings/:id
router.patch('/:id', auth, (req, res) => {
  const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  if (!meeting) return res.status(404).json({ error: 'Réunion introuvable' });

  const { title, date, time, location, status, agenda, attendees } = req.body;
  db.prepare(`
    UPDATE meetings SET
      title    = COALESCE(?, title),
      date     = COALESCE(?, date),
      time     = COALESCE(?, time),
      location = COALESCE(?, location),
      status   = COALESCE(?, status)
    WHERE id = ?
  `).run(title||null, date||null, time||null, location||null, status||null, req.params.id);

  if (Array.isArray(agenda)) {
    db.prepare('DELETE FROM agenda_items WHERE meeting_id = ?').run(req.params.id);
    const ins = db.prepare('INSERT INTO agenda_items (meeting_id, content, position) VALUES (?, ?, ?)');
    agenda.forEach((item, i) => { if (item?.trim()) ins.run(req.params.id, item.trim(), i); });
  }

  if (Array.isArray(attendees)) {
    db.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ?').run(req.params.id);
    const ins = db.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, user_id, status) VALUES (?, ?, ?)');
    attendees.forEach(uid => ins.run(req.params.id, Number(uid), 'pending'));
  }

  const updated = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
  res.json(hydrateMeeting(updated));
});

// DELETE /api/meetings/:id
router.delete('/:id', auth, (req, res) => {
  if (!db.prepare('SELECT id FROM meetings WHERE id = ?').get(req.params.id))
    return res.status(404).json({ error: 'Réunion introuvable' });
  db.prepare('DELETE FROM meetings WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /api/meetings/:id/attend
router.post('/:id/attend', auth, (req, res) => {
  const { status = 'confirmed', replacement_id } = req.body;
  const VALID = ['confirmed', 'declined', 'pending'];
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Statut invalide' });

  const repId = replacement_id ? parseInt(replacement_id) : null;

  db.prepare(`
    INSERT INTO meeting_attendees (meeting_id, user_id, status, replacement_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(meeting_id, user_id) DO UPDATE SET
      status = excluded.status,
      replacement_id = excluded.replacement_id
  `).run(req.params.id, req.user.id, status, repId);

  res.json({ success: true, status });
});

module.exports = router;
