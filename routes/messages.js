// routes/messages.js — Canaux créables et supprimables par tous
const express = require('express');
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { notifyAll } = require('../notifier');

const router = express.Router();

// GET /api/messages/channels
router.get('/channels', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM channels ORDER BY name ASC').all());
});

// POST /api/messages/channels — tous les membres
router.post('/channels', auth, (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom du canal requis' });
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
  if (db.prepare('SELECT id FROM channels WHERE name = ?').get(slug))
    return res.status(409).json({ error: 'Ce canal existe déjà' });
  const result = db.prepare('INSERT INTO channels (name, description) VALUES (?, ?)').run(slug, description || '');
  notifyAll('💬 Nouveau canal', `#${slug} créé par ${req.user.name}`, 'info', '/chat', req.user.id).catch(()=>{});
  res.status(201).json({ id: result.lastInsertRowid, name: slug, description: description || '' });
});

// DELETE /api/messages/channels/:id — tous les membres (sauf general)
router.delete('/channels/:id', auth, (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Canal introuvable' });
  if (ch.name === 'general') return res.status(400).json({ error: 'Le canal général ne peut pas être supprimé' });
  db.prepare('DELETE FROM messages WHERE channel_id = ?').run(req.params.id);
  db.prepare('DELETE FROM channels WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /api/messages/:channelName
router.get('/:channelName', auth, (req, res) => {
  const channel = db.prepare('SELECT * FROM channels WHERE name = ?').get(req.params.channelName);
  if (!channel) return res.status(404).json({ error: 'Canal introuvable' });
  const messages = db.prepare(`
    SELECT m.id, m.text, m.created_at,
           u.id as user_id, u.name as user_name, u.avatar, u.role
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ?
    ORDER BY m.created_at ASC LIMIT 100
  `).all(channel.id);
  res.json(messages.map(m => ({
    id: m.id, text: m.text, created_at: m.created_at,
    user: { id: m.user_id, name: m.user_name, avatar: m.avatar, role: m.role },
  })));
});

// POST /api/messages/:channelName
router.post('/:channelName', auth, (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Message vide' });
  const channel = db.prepare('SELECT * FROM channels WHERE name = ?').get(req.params.channelName);
  if (!channel) return res.status(404).json({ error: 'Canal introuvable' });
  const result = db.prepare('INSERT INTO messages (channel_id, user_id, text) VALUES (?, ?, ?)').run(channel.id, req.user.id, text.trim());
  const msg = db.prepare(`SELECT m.id, m.text, m.created_at, u.id as user_id, u.name as user_name, u.avatar, u.role FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`).get(result.lastInsertRowid);
  res.status(201).json({ id: msg.id, text: msg.text, created_at: msg.created_at, user: { id: msg.user_id, name: msg.user_name, avatar: msg.avatar, role: msg.role } });
});

module.exports = router;
