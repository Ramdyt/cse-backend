// routes/delegation.js — PostgreSQL
const express    = require('express');
const { query, getOne, getAll, insert } = require('../db');
const { auth }   = require('../middleware/auth');
const nodemailer = require('nodemailer');
const { createNotification } = require('../notifier');

const router = express.Router();

// ── Mailer SMTP ───────────────────────────────────────────────────────────────
async function sendMail({ subject, html }) {
  try {
    const cfg = await getOne('SELECT * FROM delegation_config WHERE id=1');
    if (!cfg?.smtp_host || !cfg?.smtp_user || !cfg?.smtp_pass || !cfg?.rh_email) {
      console.log('[Mail] Config SMTP absente — email non envoyé');
      return;
    }
    const transporter = nodemailer.createTransport({
      host: cfg.smtp_host, port: cfg.smtp_port || 587, secure: false,
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
      tls: { rejectUnauthorized: false },
    });
    await transporter.sendMail({ from: `"CSE Connect" <${cfg.smtp_user}>`, to: cfg.rh_email, subject, html });
    console.log(`[Mail] ✅ Email envoyé`);
  } catch (e) { console.error('[Mail] ⚠️', e.message); }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
async function getActiveMembers() {
  return getAll('SELECT id, name, avatar, role, titulaire FROM users WHERE pending = FALSE ORDER BY name ASC');
}

async function computeBalance(userId, year, month) {
  try {
    const cfg = await getOne('SELECT * FROM delegation_config WHERE id=1');
    if (!cfg) return null;

    const monthStr = `${year}-${String(month).padStart(2,'0')}`;
    const [py, pm] = month === 1 ? [year-1, 12] : [year, month-1];
    const prevStr  = `${py}-${String(pm).padStart(2,'0')}`;

    const startY = cfg.start_year  || 0;
    const startM = cfg.start_month || 0;

    const { rows: entryRows } = await query(
      "SELECT COUNT(*) as n FROM delegation_entries WHERE owner_id=$1 AND is_pool=FALSE AND hours > 0 AND (description NOT LIKE '[Ajustement admin%' OR description IS NULL)",
      [userId]
    );
    const hasAnyEntry   = parseInt(entryRows[0].n) > 0;
    const isBeforeStart = startY > 0 && (year < startY || (year === startY && month <= startM));
    const isStartMonth  = startY > 0 && year === startY && month === startM;
    const noStartSet    = startY === 0;
    const skipReport    = isBeforeStart || isStartMonth || (noStartSet && !hasAnyEntry);

    let report = 0;
    if (!skipReport) {
      const prevTaken = parseFloat((await getOne("SELECT COALESCE(SUM(hours),0) as h FROM delegation_entries WHERE owner_id=$1 AND is_pool=FALSE AND date LIKE $2", [userId, `${prevStr}%`]))?.h) || 0;
      const prevOut   = parseFloat((await getOne("SELECT COALESCE(SUM(hours),0) as h FROM delegation_transfers WHERE from_id=$1 AND date LIKE $2 AND status='approved'", [userId, `${prevStr}%`]))?.h) || 0;
      const prevIn    = parseFloat((await getOne("SELECT COALESCE(SUM(hours),0) as h FROM delegation_transfers WHERE to_id=$1 AND date LIKE $2 AND status='approved'", [userId, `${prevStr}%`]))?.h) || 0;
      const prevRem   = (cfg.hours_titulaire || 20) - prevTaken - prevOut + prevIn;
      report = Math.min(Math.max(prevRem, 0), (cfg.max_report || 30) - (cfg.hours_titulaire || 20));
    }

    const total  = (cfg.hours_titulaire || 20) + report;
    const taken  = parseFloat((await getOne("SELECT COALESCE(SUM(hours),0) as h FROM delegation_entries WHERE owner_id=$1 AND is_pool=FALSE AND date LIKE $2", [userId, `${monthStr}%`]))?.h) || 0;
    const out    = parseFloat((await getOne("SELECT COALESCE(SUM(hours),0) as h FROM delegation_transfers WHERE from_id=$1 AND date LIKE $2 AND status='approved'", [userId, `${monthStr}%`]))?.h) || 0;
    const inn    = parseFloat((await getOne("SELECT COALESCE(SUM(hours),0) as h FROM delegation_transfers WHERE to_id=$1 AND date LIKE $2 AND status='approved'", [userId, `${monthStr}%`]))?.h) || 0;

    const safeTotal     = Number(total)  || (cfg.hours_titulaire || 20);
    const safeTaken     = Number(taken)  || 0;
    const safeOut       = Number(out)    || 0;
    const safeIn        = Number(inn)    || 0;
    const safeRemaining = Math.max(safeTotal - safeTaken - safeOut + safeIn, 0);
    return { allocated: Number(cfg.hours_titulaire)||20, reported: Number(report)||0, total: safeTotal, taken: safeTaken, transferred_out: safeOut, transferred_in: safeIn, remaining: safeRemaining };
  } catch (e) { console.error('[computeBalance]', e.message); return null; }
}

async function poolBalance(year, month) {
  try {
    const cfg      = await getOne('SELECT * FROM delegation_config WHERE id=1');
    const monthStr = `${year}-${String(month).padStart(2,'0')}`;
    const sups     = await getAll('SELECT id FROM users WHERE titulaire=FALSE AND pending=FALSE');
    const total    = cfg?.hours_suppleant || 7;
    const { rows } = await query("SELECT COALESCE(SUM(hours),0) as h FROM delegation_entries WHERE is_pool=TRUE AND date LIKE $1", [`${monthStr}%`]);
    const taken    = parseFloat(rows[0].h) || 0;
    return { total, taken, remaining: Math.max(total - taken, 0), count: sups.length, hours_each: cfg?.hours_suppleant || 7 };
  } catch (e) { return { total:0, taken:0, remaining:0, count:0, hours_each:7 }; }
}

// ── GET /config ────────────────────────────────────────────────────────────────
router.get('/config', auth, async (req, res) => {
  try {
    const cfg = await getOne('SELECT id,hours_titulaire,hours_suppleant,max_report,rh_email,smtp_host,smtp_port,smtp_user,updated_at FROM delegation_config WHERE id=1');
    res.json(cfg || { hours_titulaire:20, hours_suppleant:7, max_report:30, rh_email:'', smtp_host:'', smtp_port:587, smtp_user:'' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /config ──────────────────────────────────────────────────────────────
router.patch('/config', auth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    const { hours_titulaire, hours_suppleant, max_report, start_year, start_month, rh_email, smtp_host, smtp_port, smtp_user, smtp_pass } = req.body;
    const sets = [], vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
    if (hours_titulaire !== undefined) add('hours_titulaire', parseFloat(hours_titulaire));
    if (hours_suppleant !== undefined) add('hours_suppleant', parseFloat(hours_suppleant));
    if (max_report      !== undefined) add('max_report',      parseFloat(max_report));
    if (start_year      !== undefined) add('start_year',      parseInt(start_year)||0);
    if (start_month     !== undefined) add('start_month',     parseInt(start_month)||0);
    if (rh_email        !== undefined) add('rh_email',        rh_email);
    if (smtp_host       !== undefined) add('smtp_host',       smtp_host);
    if (smtp_port       !== undefined) add('smtp_port',       parseInt(smtp_port)||587);
    if (smtp_user       !== undefined) add('smtp_user',       smtp_user);
    if (smtp_pass)                     add('smtp_pass',       smtp_pass);
    sets.push('updated_at=NOW()');
    if (sets.length > 1) await query(`UPDATE delegation_config SET ${sets.join(',')} WHERE id=1`, vals);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /summary ───────────────────────────────────────────────────────────────
router.get('/summary', auth, async (req, res) => {
  try {
    const year  = parseInt(req.query.year)  || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const members = await getActiveMembers();
    const result  = await Promise.all(members.map(async u => ({
      user:    { id:u.id, name:u.name, avatar:u.avatar, role:u.role, titulaire:!!u.titulaire },
      balance: u.titulaire ? await computeBalance(u.id, year, month) : null,
    })));
    res.json({ members: result, pool: await poolBalance(year, month), year, month });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /entries ───────────────────────────────────────────────────────────────
router.get('/entries', auth, async (req, res) => {
  try {
    const { year, month, user_id } = req.query;
    const monthStr = year && month ? `${year}-${String(month).padStart(2,'0')}` : null;
    const conds = [], params = [];
    const add = (c, v) => { params.push(v); conds.push(c.replace('?', `$${params.length}`)); };
    if (monthStr) add("e.date LIKE ?", `${monthStr}%`);
    if (user_id)  { params.push(user_id, user_id); conds.push(`(e.taker_id=$${params.length-1} OR e.owner_id=$${params.length})`); }
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
    const entries = await getAll(`
      SELECT e.*, t.name as taker_name, t.avatar as taker_avatar,
             o.name as owner_name, o.avatar as owner_avatar, c.name as creator_name
      FROM delegation_entries e
      JOIN users t ON t.id = e.taker_id
      LEFT JOIN users o ON o.id = e.owner_id
      LEFT JOIN users c ON c.id = e.created_by
      ${where} ORDER BY e.date DESC, e.created_at DESC
    `, params);
    res.json(entries);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /entries ──────────────────────────────────────────────────────────────
router.post('/entries', auth, async (req, res) => {
  try {
    const { taker_id, owner_id, is_pool, hours, date, description } = req.body;
    if (!taker_id || !hours || !date) return res.status(400).json({ error: 'Bénéficiaire, heures et date requis' });
    if (parseFloat(hours) <= 0) return res.status(400).json({ error: 'Les heures doivent être positives' });

    const pool   = !!is_pool;
    const h      = parseFloat(hours);
    const [y, m] = date.split('-').map(Number);

    if (pool) {
      const p = await poolBalance(y, m);
      if (p?.total > 0 && h > p.remaining) return res.status(400).json({ error: `Pot commun insuffisant : ${p.remaining}h disponibles` });
    } else {
      const ownerId = parseInt(owner_id || taker_id);
      const bal     = await computeBalance(ownerId, y, m);
      if (bal?.total > 0 && h > bal.remaining) return res.status(400).json({ error: `Solde insuffisant : ${bal.remaining}h disponibles` });
    }

    const id = await insert(
      'INSERT INTO delegation_entries (taker_id, owner_id, is_pool, hours, date, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [parseInt(taker_id), pool ? null : parseInt(owner_id || taker_id), pool, h, date, description||'', req.user.id]
    );

    const taker      = await getOne('SELECT name FROM users WHERE id=$1', [taker_id]);
    const ownerLabel = pool ? 'pot commun' : ((await getOne('SELECT name FROM users WHERE id=$1', [owner_id || taker_id]))?.name || '—');
    const body       = `${taker?.name} : ${hours}h sur ${ownerLabel} le ${date}${description ? ' — '+description : ''}`;
    const allUsers   = await getActiveMembers();
    for (const u of allUsers) await createNotification(u.id, "⏱ Prise d'heures", body, 'delegation', '/delegation');

    sendMail({
      subject: `[CSE] Prise d'heures — ${taker?.name}`,
      html: `<p>Bonjour,</p><p>Une prise d'heures a été enregistrée :</p>
        <ul><li><b>Bénéficiaire :</b> ${taker?.name}</li><li><b>Compteur :</b> ${ownerLabel}</li>
        <li><b>Heures :</b> ${hours}h</li><li><b>Date :</b> ${date}</li>
        ${description ? `<li><b>Motif :</b> ${description}</li>` : ''}</ul>
        <p>Cordialement,<br>CSE Connect</p>`,
    });

    res.status(201).json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /entries/:id ────────────────────────────────────────────────────────
router.delete('/entries/:id', auth, async (req, res) => {
  try {
    const e = await getOne('SELECT * FROM delegation_entries WHERE id=$1', [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Introuvable' });
    if (e.created_by !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Non autorisé' });
    await query('DELETE FROM delegation_entries WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /transfers ─────────────────────────────────────────────────────────────
router.get('/transfers', auth, async (req, res) => {
  try {
    res.json(await getAll(`
      SELECT dt.*, f.name as from_name, f.avatar as from_avatar, t.name as to_name, t.avatar as to_avatar
      FROM delegation_transfers dt
      JOIN users f ON f.id = dt.from_id JOIN users t ON t.id = dt.to_id
      ORDER BY dt.created_at DESC LIMIT 100
    `));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /transfers ────────────────────────────────────────────────────────────
router.post('/transfers', auth, async (req, res) => {
  try {
    const { from_id, to_id, hours, date, note } = req.body;
    if (!from_id || !to_id || !hours || !date) return res.status(400).json({ error: 'Champs requis manquants' });
    const id = await insert(
      'INSERT INTO delegation_transfers (from_id, to_id, hours, date, note, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [parseInt(from_id), parseInt(to_id), parseFloat(hours), date, note||'', 'pending']
    );
    const toUser = await getOne('SELECT name FROM users WHERE id=$1', [to_id]);
    await createNotification(parseInt(from_id), '🔄 Demande de mutualisation', `${toUser?.name} demande ${hours}h de votre compteur`, 'warning', '/delegation');
    res.status(201).json({ id, status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /transfers/:id ───────────────────────────────────────────────────────
router.patch('/transfers/:id', auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
    const t = await getOne('SELECT * FROM delegation_transfers WHERE id=$1', [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Introuvable' });
    if (t.from_id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Non autorisé' });
    await query('UPDATE delegation_transfers SET status=$1 WHERE id=$2', [status, req.params.id]);

    const fromUser = await getOne('SELECT name FROM users WHERE id=$1', [t.from_id]);
    const toUser   = await getOne('SELECT name FROM users WHERE id=$1', [t.to_id]);
    const label    = status === 'approved' ? 'approuvée ✅' : 'refusée ❌';
    await createNotification(t.to_id, `Mutualisation ${label}`, `${fromUser?.name} a ${status==='approved'?'approuvé':'refusé'} ${t.hours}h`, status==='approved'?'success':'error', '/delegation');

    if (status === 'approved') {
      sendMail({
        subject: "[CSE] Mutualisation d'heures approuvée",
        html: `<p>Bonjour,</p><p>Une mutualisation a été approuvée :</p>
          <ul><li><b>De :</b> ${fromUser?.name}</li><li><b>À :</b> ${toUser?.name}</li>
          <li><b>Heures :</b> ${t.hours}h</li><li><b>Date :</b> ${t.date}</li>
          ${t.note ? `<li><b>Motif :</b> ${t.note}</li>` : ''}</ul>
          <p>Cordialement,<br>CSE Connect</p>`,
      });
    }
    res.json({ success: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /notifications ─────────────────────────────────────────────────────────
router.get('/notifications', auth, async (req, res) => {
  try {
    await query("DELETE FROM notifications WHERE user_id=$1 AND read=TRUE AND created_at < NOW() - INTERVAL '7 days'", [req.user.id]);
    const notifs = await getAll(`
      SELECT * FROM notifications
      WHERE user_id=$1 AND (read=FALSE OR created_at > NOW() - INTERVAL '1 hour')
      ORDER BY created_at DESC LIMIT 50
    `, [req.user.id]);
    res.json(notifs);
  } catch { res.json([]); }
});

router.patch('/notifications/:id/read', auth, async (req, res) => {
  try { await query('UPDATE notifications SET read=TRUE WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]); } catch {}
  res.json({ success: true });
});

router.patch('/notifications/read-all', auth, async (req, res) => {
  try { await query('UPDATE notifications SET read=TRUE WHERE user_id=$1', [req.user.id]); } catch {}
  res.json({ success: true });
});

// ── GET /entries/all ───────────────────────────────────────────────────────────
router.get('/entries/all', auth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    res.json(await getAll(`
      SELECT e.*, t.name as taker_name, t.avatar as taker_avatar,
             o.name as owner_name, c.name as creator_name
      FROM delegation_entries e
      JOIN users t ON t.id = e.taker_id
      LEFT JOIN users o ON o.id = e.owner_id
      LEFT JOIN users c ON c.id = e.created_by
      ORDER BY e.date DESC, e.created_at DESC
    `));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /entries/:id ─────────────────────────────────────────────────────────
router.patch('/entries/:id', auth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    const entry = await getOne('SELECT * FROM delegation_entries WHERE id=$1', [req.params.id]);
    if (!entry) return res.status(404).json({ error: 'Entrée introuvable' });
    const { hours, date, description, owner_id, is_pool } = req.body;
    await query(`UPDATE delegation_entries SET
      hours       = COALESCE($1, hours),
      date        = COALESCE($2, date),
      description = COALESCE($3, description),
      owner_id    = CASE WHEN $4::integer IS NOT NULL THEN $4::integer ELSE owner_id END,
      is_pool     = COALESCE($5, is_pool)
      WHERE id = $6
    `, [hours||null, date||null, description||null, owner_id||null, is_pool!=null?is_pool:null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /entries/admin ────────────────────────────────────────────────────────
router.post('/entries/admin', auth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    const { taker_id, owner_id, is_pool, hours, date, description } = req.body;
    if (!taker_id || !hours || !date) return res.status(400).json({ error: 'Bénéficiaire, heures et date requis' });
    const id = await insert(
      'INSERT INTO delegation_entries (taker_id, owner_id, is_pool, hours, date, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [parseInt(taker_id), is_pool ? null : parseInt(owner_id || taker_id), !!is_pool, parseFloat(hours), date, description || '[Correction admin]', req.user.id]
    );
    res.status(201).json({ id, success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /adjust ───────────────────────────────────────────────────────────────
router.post('/adjust', auth, async (req, res) => {
  if (!req.user.is_admin) return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    const { user_id, target_hours, month, year, note } = req.body;
    if (!user_id || target_hours === undefined) return res.status(400).json({ error: 'user_id et target_hours requis' });

    const y = parseInt(year)  || new Date().getFullYear();
    const m = parseInt(month) || new Date().getMonth() + 1;
    const adjustDate = `${y}-${String(m).padStart(2,'0')}-15`;

    const current          = await computeBalance(parseInt(user_id), y, m);
    const currentRemaining = current ? Number(current.remaining) : 20;
    const target           = parseFloat(target_hours);

    if (Math.abs(target - currentRemaining) < 0.01)
      return res.json({ success: true, message: 'Déjà à la bonne valeur', new_remaining: currentRemaining });

    const description = note || `[Ajustement admin : ${currentRemaining}h → ${target}h]`;
    const diff        = target - currentRemaining;
    const entryHours  = diff > 0 ? -Math.abs(diff) : Math.abs(diff);

    await query(
      'INSERT INTO delegation_entries (taker_id, owner_id, is_pool, hours, date, description, created_by) VALUES ($1,$2,FALSE,$3,$4,$5,$6)',
      [parseInt(user_id), parseInt(user_id), entryHours, adjustDate, description, req.user.id]
    );

    const newBalance = await computeBalance(parseInt(user_id), y, m);
    res.json({ success: true, previous: currentRemaining, target, new_remaining: newBalance ? Number(newBalance.remaining) : target });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
