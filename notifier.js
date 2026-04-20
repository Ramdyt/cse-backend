// notifier.js — Notifications IN-APP + PUSH (PostgreSQL)
const { getAll, query } = require('./db');

async function getAllUserIds() {
  const rows = await getAll('SELECT id FROM users WHERE pending = FALSE');
  return rows.map(u => u.id);
}

async function createNotification(userId, title, body, type = 'info', link = '') {
  try {
    await query(
      'INSERT INTO notifications (user_id, title, body, type, link) VALUES ($1,$2,$3,$4,$5)',
      [userId, title, body, type, link]
    );
  } catch (e) {
    console.error('[Notif]', e.message);
  }
}

async function notifyAll(title, body, type = 'info', link = '/', excludeUserId = null) {
  try {
    const ids = (await getAllUserIds()).filter(id => id !== excludeUserId);
    for (const id of ids) await createNotification(id, title, body, type, link);
    if (global.sendPush) {
      await global.sendPush(ids, { title, body, url: link }).catch(() => {});
    }
  } catch (e) {
    console.error('[notifyAll]', e.message);
  }
}

async function notifyUser(userId, title, body, type = 'info', link = '/') {
  await createNotification(userId, title, body, type, link);
  if (global.sendPush) {
    await global.sendPush([userId], { title, body, url: link }).catch(() => {});
  }
}

module.exports = { notifyAll, notifyUser, createNotification };
