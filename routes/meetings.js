// routes/meetings.js — PostgreSQL
const express = require('express');
const { query, getOne, getAll, insert } = require('../db');
const { auth } = require('../middleware/auth');
const { notifyAll } = require('../notifier');

const router = express.Router();

async function hydrateMeeting(meeting) {
  const agenda = await getAll(
    'SELECT id, content, position FROM agenda_items WHERE meeting_id = $1 ORDER BY position ASC',
    [meeting.id]
  );
  const attendees = await getAll(`
    SELECT u.id, u.name, u.role, u.avatar, u.titulaire,
           ma.status as attendance, ma.replacement_id
    FROM meeting_attendees ma JOIN users u ON u.id = ma.user_id
    WHERE ma.meeting_id = $1
    ORDER BY u.titulaire DESC, u.name ASC
  `, [meeting.id]);
  return { ...meeting, agenda, attendees };
}

// GET /api/meetings
router.get('/', auth, async (req, res) => {
  try {
    const meetings = await getAll('SELECT * FROM meetings ORDER BY date ASC, time ASC');
    const hydrated = await Promise.all(meetings.map(hydrateMeeting));
    res.json(hydrated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/meetings/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const meeting = await getOne('SELECT * FROM meetings WHERE id = $1', [req.params.id]);
    if (!meeting) return res.status(404).json({ error: 'Réunion introuvable' });
    res.json(await hydrateMeeting(meeting));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/meetings
router.post('/', auth, async (req, res) => {
  try {
    const { title, date, time, location, agenda = [], attendees = [] } = req.body;
    if (!title?.trim() || !date || !time) return res.status(400).json({ error: 'Titre, date et heure requis' });

    const status = new Date(date) < new Date() ? 'past' : 'upcoming';
    const meetingId = await insert(
      'INSERT INTO meetings (title, date, time, location, status, created_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [title.trim(), date, time, location || '', status, req.user.id]
    );

    // Ordre du jour
    for (let i = 0; i < agenda.length; i++) {
      if (agenda[i]?.trim()) {
        await query('INSERT INTO agenda_items (meeting_id, content, position) VALUES ($1,$2,$3)', [meetingId, agenda[i].trim(), i]);
      }
    }

    // Ajouter tous les membres actifs
    const allUsers = await getAll('SELECT id FROM users WHERE pending = FALSE');
    for (const u of allUsers) {
      const s = attendees.includes(u.id) || attendees.includes(String(u.id)) ? 'confirmed' : 'pending';
      await query(
        'INSERT INTO meeting_attendees (meeting_id, user_id, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [meetingId, u.id, s]
      );
    }

    const meeting = await getOne('SELECT * FROM meetings WHERE id = $1', [meetingId]);
    notifyAll('📅 Nouvelle réunion', `${title.trim()} — ${date} à ${time}`, 'info', '/meetings', req.user.id).catch(() => {});
    res.status(201).json(await hydrateMeeting(meeting));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/meetings/:id
router.patch('/:id', auth, async (req, res) => {
  try {
    const meeting = await getOne('SELECT * FROM meetings WHERE id = $1', [req.params.id]);
    if (!meeting) return res.status(404).json({ error: 'Réunion introuvable' });

    const { title, date, time, location, status, agenda, attendees } = req.body;
    await query(`
      UPDATE meetings SET
        title    = COALESCE($1, title),
        date     = COALESCE($2, date),
        time     = COALESCE($3, time),
        location = COALESCE($4, location),
        status   = COALESCE($5, status)
      WHERE id = $6
    `, [title || null, date || null, time || null, location || null, status || null, req.params.id]);

    if (Array.isArray(agenda)) {
      await query('DELETE FROM agenda_items WHERE meeting_id = $1', [req.params.id]);
      for (let i = 0; i < agenda.length; i++) {
        if (agenda[i]?.trim()) await query('INSERT INTO agenda_items (meeting_id, content, position) VALUES ($1,$2,$3)', [req.params.id, agenda[i].trim(), i]);
      }
    }

    if (Array.isArray(attendees)) {
      await query('DELETE FROM meeting_attendees WHERE meeting_id = $1', [req.params.id]);
      for (const uid of attendees) {
        await query('INSERT INTO meeting_attendees (meeting_id, user_id, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.params.id, Number(uid), 'pending']);
      }
    }

    const updated = await getOne('SELECT * FROM meetings WHERE id = $1', [req.params.id]);
    res.json(await hydrateMeeting(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/meetings/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const m = await getOne('SELECT id FROM meetings WHERE id = $1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Réunion introuvable' });
    await query('DELETE FROM meetings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/meetings/:id/attend
router.post('/:id/attend', auth, async (req, res) => {
  try {
    const { status = 'confirmed', replacement_id } = req.body;
    const VALID = ['confirmed', 'declined', 'pending'];
    if (!VALID.includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    const repId = replacement_id ? parseInt(replacement_id) : null;
    await query(`
      INSERT INTO meeting_attendees (meeting_id, user_id, status, replacement_id)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (meeting_id, user_id) DO UPDATE SET
        status = EXCLUDED.status,
        replacement_id = EXCLUDED.replacement_id
    `, [req.params.id, req.user.id, status, repId]);
    res.json({ success: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
