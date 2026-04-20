// routes/auth.js — PostgreSQL
const express = require('express');
const bcrypt  = require('bcryptjs');
const { query, getOne, getAll } = require('../db');
const { auth, signToken } = require('../middleware/auth');

const router = express.Router();
const VALID_ROLES = ['Membre', 'Secrétaire', 'Trésorier', 'Délégué syndicat'];

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const user = await getOne('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });
    if (user.pending) return res.status(403).json({ error: 'Votre compte est en attente de validation par un administrateur.' });

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

    const token = signToken({ id: user.id, name: user.name, role: user.role, avatar: user.avatar, is_admin: user.is_admin });
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, is_admin: !!user.is_admin, titulaire: !!user.titulaire, theme: user.theme || 'Cosmos' },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const user = await getOne(
      'SELECT id, name, email, role, avatar, is_admin, titulaire, theme, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ ...user, is_admin: !!user.is_admin, titulaire: !!user.titulaire, theme: user.theme || 'Cosmos' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/users
router.get('/users', auth, async (req, res) => {
  try {
    const { pending } = req.query;
    const condition = pending === '1' ? 'WHERE pending = TRUE' : 'WHERE pending = FALSE';
    const users = await getAll(
      `SELECT id, name, email, role, avatar, is_admin, titulaire, pending, created_at FROM users ${condition} ORDER BY name ASC`
    );
    res.json(users.map(u => ({ ...u, is_admin: !!u.is_admin, titulaire: !!u.titulaire, pending: !!u.pending })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name?.trim() || !email?.trim() || !password?.trim())
      return res.status(400).json({ error: 'Nom, email et mot de passe sont obligatoires' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });

    const emailNorm = email.trim().toLowerCase();
    const existing = await getOne('SELECT id FROM users WHERE email = $1', [emailNorm]);
    if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    const hash      = bcrypt.hashSync(password, 10);
    const avatar    = name.trim().split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
    const finalRole = VALID_ROLES.includes(role) ? role : 'Membre';

    await query(
      'INSERT INTO users (name, email, password, role, avatar, is_admin, titulaire, pending) VALUES ($1,$2,$3,$4,$5,FALSE,TRUE,TRUE)',
      [name.trim(), emailNorm, hash, finalRole, avatar]
    );
    res.status(201).json({ message: 'Compte créé, en attente de validation par un administrateur.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/approve/:id
router.post('/approve/:id', auth, async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
    const user = await getOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    await query('UPDATE users SET pending = FALSE WHERE id = $1', [req.params.id]);

    // Ajouter le nouvel utilisateur aux réunions à venir
    const meetings = await getAll("SELECT id FROM meetings WHERE status = 'upcoming'");
    for (const m of meetings) {
      await query(
        'INSERT INTO meeting_attendees (meeting_id, user_id, status) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [m.id, req.params.id, 'pending']
      );
    }
    res.json({ success: true, message: `Compte de ${user.name} approuvé` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/auth/users/:id
router.delete('/users/:id', auth, async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    const user = await getOne('SELECT * FROM users WHERE id = $1', [targetId]);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    await query('DELETE FROM meeting_attendees WHERE user_id = $1', [targetId]);
    await query('UPDATE notes SET author_id = $1 WHERE author_id = $2', [req.user.id, targetId]);
    await query('UPDATE documents SET uploaded_by = $1 WHERE uploaded_by = $2', [req.user.id, targetId]);
    await query('DELETE FROM users WHERE id = $1', [targetId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/auth/users/:id/password
router.patch('/users/:id/password', auth, async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min. 6 caractères)' });
    const user = await getOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    await query('UPDATE users SET password = $1 WHERE id = $2', [bcrypt.hashSync(password, 10), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/auth/users/:id
router.patch('/users/:id', auth, async (req, res) => {
  try {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
    const { role, titulaire, is_admin } = req.body;
    const user = await getOne('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const newRole      = VALID_ROLES.includes(role) ? role : user.role;
    const newTitulaire = titulaire !== undefined ? !!titulaire : user.titulaire;
    const newAdmin     = is_admin  !== undefined ? !!is_admin  : user.is_admin;

    if (parseInt(req.params.id) === req.user.id && !is_admin)
      return res.status(400).json({ error: 'Impossible de vous retirer les droits admin' });

    await query('UPDATE users SET role=$1, titulaire=$2, is_admin=$3 WHERE id=$4', [newRole, newTitulaire, newAdmin, req.params.id]);
    const updated = await getOne('SELECT id, name, email, role, avatar, is_admin, titulaire, pending FROM users WHERE id=$1', [req.params.id]);
    res.json({ ...updated, is_admin: !!updated.is_admin, titulaire: !!updated.titulaire });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/auth/me/theme
router.patch('/me/theme', auth, async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme) return res.status(400).json({ error: 'Thème requis' });
    await query('UPDATE users SET theme = $1 WHERE id = $2', [theme, req.user.id]);
    res.json({ success: true, theme });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
