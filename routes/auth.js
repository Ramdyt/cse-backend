// routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const db      = require('../db');

// Migration douce — colonne theme
try { db.exec("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'Cosmos'"); } catch {}
const { auth, signToken } = require('../middleware/auth');

const router = express.Router();

// Migration douce — toutes les colonnes users
[
  "ALTER TABLE users ADD COLUMN is_admin  INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN titulaire INTEGER DEFAULT 1",
  "ALTER TABLE users ADD COLUMN pending   INTEGER DEFAULT 0",
].forEach(sql => { try { db.exec(sql); } catch {} });

const VALID_ROLES = ['Membre', 'Secrétaire', 'Trésorier', 'Délégué syndicat'];

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'Email et mot de passe requis' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

  if (user.pending)
    return res.status(403).json({ error: 'Votre compte est en attente de validation par un administrateur.' });

  const valid = bcrypt.compareSync(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = signToken({ id: user.id, name: user.name, role: user.role, avatar: user.avatar, is_admin: user.is_admin });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.avatar, is_admin: !!user.is_admin, titulaire: !!user.titulaire, theme: user.theme || 'Cosmos' },
  });
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, avatar, is_admin, titulaire, theme, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ ...user, is_admin: !!user.is_admin, titulaire: !!user.titulaire, theme: user.theme || 'Cosmos' });
});

// GET /api/auth/users
router.get('/users', auth, (req, res) => {
  const { pending } = req.query;
  let query = 'SELECT id, name, email, role, avatar, is_admin, titulaire, pending, created_at FROM users';
  if (pending === '1') query += ' WHERE pending = 1';
  else query += ' WHERE pending = 0';
  query += ' ORDER BY name ASC';
  const users = db.prepare(query).all();
  res.json(users.map(u => ({ ...u, is_admin: !!u.is_admin, titulaire: !!u.titulaire, pending: !!u.pending })));
});

// POST /api/auth/register — inscription libre, compte en attente
router.post('/register', (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name?.trim() || !email?.trim() || !password?.trim())
    return res.status(400).json({ error: 'Nom, email et mot de passe sont obligatoires' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères' });

  const emailNorm = email.trim().toLowerCase();
  const existing  = db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm);
  if (existing) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

  const hash      = bcrypt.hashSync(password, 10);
  const avatar    = name.trim().split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
  const finalRole = VALID_ROLES.includes(role) ? role : 'Membre';

  const result = db.prepare(
    'INSERT INTO users (name, email, password, role, avatar, is_admin, titulaire, pending) VALUES (?, ?, ?, ?, ?, 0, 1, 1)'
  ).run(name.trim(), emailNorm, hash, finalRole, avatar);

  res.status(201).json({ message: 'Compte créé, en attente de validation par un administrateur.' });
});

// POST /api/auth/approve/:id — valider un compte (admin uniquement)
router.post('/approve/:id', auth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  db.prepare('UPDATE users SET pending = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: `Compte de ${user.name} approuvé` });
});

// DELETE /api/auth/users/:id
router.delete('/users/:id', auth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id)
    return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  // Nettoyer les références
  db.prepare('DELETE FROM meeting_attendees WHERE user_id = ?').run(targetId);
  db.prepare('UPDATE notes SET author_id = ? WHERE author_id = ?').run(req.user.id, targetId);
  db.prepare('UPDATE documents SET uploaded_by = ? WHERE uploaded_by = ?').run(req.user.id, targetId);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ success: true });
});

// PATCH /api/auth/users/:id/password
router.patch('/users/:id/password', auth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  const { password } = req.body;
  if (!password || password.length < 6)
    return res.status(400).json({ error: 'Mot de passe trop court (min. 6 caractères)' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ success: true });
});

// PATCH /api/auth/users/:id — modifier rôle, titulaire, is_admin
router.patch('/users/:id', auth, (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Accès refusé' });
  const { role, titulaire, is_admin } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

  const newRole      = VALID_ROLES.includes(role) ? role : user.role;
  const newTitulaire = titulaire !== undefined ? (titulaire ? 1 : 0) : user.titulaire;
  const newAdmin     = is_admin  !== undefined ? (is_admin  ? 1 : 0) : user.is_admin;

  // Empêcher de se retirer son propre admin
  if (parseInt(req.params.id) === req.user.id && !is_admin)
    return res.status(400).json({ error: 'Impossible de vous retirer les droits admin' });

  db.prepare('UPDATE users SET role = ?, titulaire = ?, is_admin = ? WHERE id = ?')
    .run(newRole, newTitulaire, newAdmin, req.params.id);

  const updated = db.prepare('SELECT id, name, email, role, avatar, is_admin, titulaire, pending FROM users WHERE id = ?').get(req.params.id);
  res.json({ ...updated, is_admin: !!updated.is_admin, titulaire: !!updated.titulaire });
});

// PATCH /api/auth/me/theme — sauvegarder le thème de l'utilisateur
router.patch('/me/theme', auth, (req, res) => {
  const { theme } = req.body;
  if (!theme) return res.status(400).json({ error: 'Thème requis' });
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.user.id);
  res.json({ success: true, theme });
});

module.exports = router;
