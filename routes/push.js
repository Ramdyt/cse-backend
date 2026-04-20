// routes/push.js — PostgreSQL
const express  = require('express');
const webpush  = require('web-push');
const { query, getOne, getAll } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

async function ensureVapidKeys() {
  const cfg = await getOne('SELECT * FROM push_config WHERE id=1');
  if (!cfg?.vapid_public || !cfg?.vapid_private) {
    const keys = webpush.generateVAPIDKeys();
    await query('UPDATE push_config SET vapid_public=$1, vapid_private=$2 WHERE id=1', [keys.publicKey, keys.privateKey]);
    console.log('🔑 Clés VAPID générées');
    return keys;
  }
  return { publicKey: cfg.vapid_public, privateKey: cfg.vapid_private };
}

let vapidKeys;
(async () => {
  try {
    vapidKeys = await ensureVapidKeys();
    const cfg = await getOne('SELECT vapid_email FROM push_config WHERE id=1');
    webpush.setVapidDetails(`mailto:${cfg.vapid_email}`, vapidKeys.publicKey, vapidKeys.privateKey);
  } catch (e) { console.error('Web Push init error:', e.message); }
})();

// GET /vapid-key
router.get('/vapid-key', async (req, res) => {
  try {
    const cfg = await getOne('SELECT vapid_public FROM push_config WHERE id=1');
    res.json({ publicKey: cfg?.vapid_public || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /subscribe
router.post('/subscribe', auth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Abonnement invalide' });
    await query(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth_key)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id
    `, [req.user.id, endpoint, keys.p256dh, keys.auth]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /subscribe
router.delete('/subscribe', auth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) await query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [endpoint, req.user.id]);
    else await query('DELETE FROM push_subscriptions WHERE user_id=$1', [req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function sendPush(userIds, payload) {
  if (!vapidKeys?.publicKey) return;
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  if (ids.length === 0) return;
  const placeholders = ids.map((_, i) => `$${i+1}`).join(',');
  const subs = await getAll(`SELECT * FROM push_subscriptions WHERE user_id IN (${placeholders})`, ids);
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const sub of subs) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } }, msg);
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await query('DELETE FROM push_subscriptions WHERE endpoint=$1', [sub.endpoint]);
      }
    }
  }
}

// POST /test
router.post('/test', auth, async (req, res) => {
  await sendPush([req.user.id], { title: '🔔 Test CSE Connect', body: 'Les notifications push fonctionnent !', url: '/' });
  res.json({ success: true });
});

module.exports = { router, sendPush };
