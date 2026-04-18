// notifier.js — Envoie notifications IN-APP + PUSH pour toutes les actions
const db = require('./db');

function getAllUserIds() {
  return db.prepare('SELECT id FROM users WHERE pending=0').all().map(u => u.id);
}

function createNotification(userId, title, body, type='info', link='') {
  try {
    db.prepare('INSERT INTO notifications (user_id, title, body, type, link) VALUES (?,?,?,?,?)')
      .run(userId, title, body, type, link);
  } catch {}
}

async function notifyAll(title, body, type='info', link='/', excludeUserId=null) {
  const ids = getAllUserIds().filter(id => id !== excludeUserId);
  // Notif in-app
  for (const id of ids) createNotification(id, title, body, type, link);
  // Notif push
  if (global.sendPush) {
    await global.sendPush(ids, { title, body, url: link }).catch(()=>{});
  }
}

async function notifyUser(userId, title, body, type='info', link='/') {
  createNotification(userId, title, body, type, link);
  if (global.sendPush) {
    await global.sendPush([userId], { title, body, url: link }).catch(()=>{});
  }
}

module.exports = { notifyAll, notifyUser, createNotification };
