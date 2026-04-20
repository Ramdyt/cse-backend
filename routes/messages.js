// routes/messages.js — PostgreSQL
const express = require('express');
const { query, getOne, getAll, insert } = require('../db');
const { auth } = require('../middleware/auth');
const { notifyAll } = require('../notifier');

const router = express.Router();

// GET /api/messages/channels
router.get('/channels', auth, async (req, res) => {
  try {
    res.json(await getAll('SELECT * FROM channels ORDER BY name ASC'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/channels
router.post('/channels', auth, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nom du canal requis' });
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
    const existing = await getOne('SELECT id FROM channels WHERE name = $1', [slug]);
    if (existing) return res.status(409).json({ error: 'Ce canal existe déjà' });
    const id = await insert('INSERT INTO channels (name, description) VALUES ($1,$2)', [slug, description || '']);
    notifyAll('💬 Nouveau canal', `#${slug} créé par ${req.user.name}`, 'info', '/chat', req.user.id).catch(() => {});
    res.status(201).json({ id, name: slug, description: description || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/messages/channels/:id
router.delete('/channels/:id', auth, async (req, res) => {
  try {
    const ch = await getOne('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    if (!ch) return res.status(404).json({ error: 'Canal introuvable' });
    if (ch.name === 'general') return res.status(400).json({ error: 'Le canal général ne peut pas être supprimé' });
    await query('DELETE FROM messages WHERE channel_id = $1', [req.params.id]);
    await query('DELETE FROM channels WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/messages/:channelName
router.get('/:channelName', auth, async (req, res) => {
  try {
    const channel = await getOne('SELECT * FROM channels WHERE name = $1', [req.params.channelName]);
    if (!channel) return res.status(404).json({ error: 'Canal introuvable' });
    const messages = await getAll(`
      SELECT m.id, m.text, m.created_at,
             u.id as user_id, u.name as user_name, u.avatar, u.role
      FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = $1
      ORDER BY m.created_at ASC LIMIT 100
    `, [channel.id]);
    res.json(messages.map(m => ({
      id: m.id, text: m.text, created_at: m.created_at,
      user: { id: m.user_id, name: m.user_name, avatar: m.avatar, role: m.role },
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/messages/:channelName
router.post('/:channelName', auth, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: 'Message vide' });
    const channel = await getOne('SELECT * FROM channels WHERE name = $1', [req.params.channelName]);
    if (!channel) return res.status(404).json({ error: 'Canal introuvable' });
    const id = await insert('INSERT INTO messages (channel_id, user_id, text) VALUES ($1,$2,$3)', [channel.id, req.user.id, text.trim()]);
    const msg = await getOne(`
      SELECT m.id, m.text, m.created_at, u.id as user_id, u.name as user_name, u.avatar, u.role
      FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1
    `, [id]);
    res.status(201).json({ id: msg.id, text: msg.text, created_at: msg.created_at, user: { id: msg.user_id, name: msg.user_name, avatar: msg.avatar, role: msg.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
