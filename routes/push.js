// routes/push.js — Notifications push (Web Push API)
const express  = require('express');
const webpush  = require('web-push');
const db       = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// ── Table abonnements push ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT    NOT NULL UNIQUE,
    p256dh     TEXT    NOT NULL,
    auth_key   TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS push_config (
    id           INTEGER PRIMARY KEY DEFAULT 1,
    vapid_public TEXT,
    vapid_private TEXT,
    vapid_email  TEXT DEFAULT 'contact@cse.fr'
  );
  INSERT OR IGNORE INTO push_config (id) VALUES (1);
`);

// Générer les clés VAPID si pas encore fait
function ensureVapidKeys() {
  const cfg = db.prepare('SELECT * FROM push_config WHERE id=1').get();
  if (!cfg.vapid_public || !cfg.vapid_private) {
    const keys = webpush.generateVAPIDKeys();
    db.prepare('UPDATE push_config SET vapid_public=?, vapid_private=? WHERE id=1')
      .run(keys.publicKey, keys.privateKey);
    console.log('🔑 Clés VAPID générées');
    return keys;
  }
  return { publicKey: cfg.vapid_public, privateKey: cfg.vapid_private };
}

let vapidKeys;
try {
  vapidKeys = ensureVapidKeys();
  const cfg = db.prepare('SELECT vapid_email FROM push_config WHERE id=1').get();
  webpush.setVapidDetails(
    `mailto:${cfg.vapid_email}`,
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
} catch(e) {
  console.error('Web Push init error:', e.message);
}

// ── GET clé publique VAPID (nécessaire côté client) ───────────────────────────
router.get('/vapid-key', (req, res) => {
  const cfg = db.prepare('SELECT vapid_public FROM push_config WHERE id=1').get();
  res.json({ publicKey: cfg?.vapid_public || null });
});

// ── POST abonnement push ──────────────────────────────────────────────────────
router.post('/subscribe', auth, (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth)
    return res.status(400).json({ error: 'Abonnement invalide' });

  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_key)
    VALUES (?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id
  `).run(req.user.id, endpoint, keys.p256dh, keys.auth);

  res.json({ success: true });
});

// ── DELETE abonnement push ────────────────────────────────────────────────────
router.delete('/subscribe', auth, (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(endpoint, req.user.id);
  else db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(req.user.id);
  res.json({ success: true });
});

// ── Fonction utilitaire : envoyer une notif push à un ou plusieurs users ──────
async function sendPush(userIds, payload) {
  if (!vapidKeys?.publicKey) return;
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  const placeholders = ids.map(() => '?').join(',');
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`).all(...ids);

  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
        msg
      );
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // Abonnement expiré → supprimer
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(sub.endpoint);
      }
    }
  }
}

// ── POST test (admin) ─────────────────────────────────────────────────────────
router.post('/test', auth, async (req, res) => {
  await sendPush([req.user.id], {
    title: '🔔 Test CSE Connect',
    body:  'Les notifications push fonctionnent correctement !',
    url:   '/',
  });
  res.json({ success: true });
});

module.exports = { router, sendPush };
