// routes/delegation.js
const express = require("express");
const db = require("../db");
const { auth } = require("../middleware/auth");
const nodemailer = require("nodemailer");

const router = express.Router();

// ── Tables — création sécurisée colonne par colonne ───────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS delegation_config (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    hours_titulaire REAL    DEFAULT 20,
    hours_suppleant REAL    DEFAULT 7,
    max_report      REAL    DEFAULT 30,
    start_year      INTEGER DEFAULT 0,
    start_month     INTEGER DEFAULT 0,
    rh_email        TEXT    DEFAULT '',
    smtp_host       TEXT    DEFAULT '',
    smtp_port       INTEGER DEFAULT 587,
    smtp_user       TEXT    DEFAULT '',
    smtp_pass       TEXT    DEFAULT '',
    updated_at      TEXT    DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO delegation_config (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS delegation_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    taker_id    INTEGER NOT NULL REFERENCES users(id),
    owner_id    INTEGER,
    is_pool     INTEGER DEFAULT 0,
    hours       REAL    NOT NULL,
    date        TEXT    NOT NULL,
    description TEXT,
    created_by  INTEGER REFERENCES users(id),
    created_at  TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS delegation_transfers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id    INTEGER NOT NULL REFERENCES users(id),
    to_id      INTEGER NOT NULL REFERENCES users(id),
    hours      REAL    NOT NULL,
    date       TEXT    NOT NULL,
    note       TEXT,
    status     TEXT    DEFAULT 'pending',
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      TEXT    NOT NULL,
    body       TEXT,
    type       TEXT    DEFAULT 'info',
    read       INTEGER DEFAULT 0,
    link       TEXT,
    created_at TEXT    DEFAULT (datetime('now'))
  );
`);

// ── Migration douce — colonnes users
[
  "titulaire INTEGER DEFAULT 1",
  "pending INTEGER DEFAULT 0",
  "is_admin INTEGER DEFAULT 0",
].forEach((col) => {
  try {
    db.exec("ALTER TABLE users ADD COLUMN " + col);
  } catch {}
});

// ── Migration douce — colonnes delegation_config
[
  "rh_email    TEXT    DEFAULT ''",
  "smtp_host   TEXT    DEFAULT ''",
  "smtp_port   INTEGER DEFAULT 587",
  "smtp_user   TEXT    DEFAULT ''",
  "smtp_pass   TEXT    DEFAULT ''",
  "start_year  INTEGER DEFAULT 0",
  "start_month INTEGER DEFAULT 0",
].forEach((col) => {
  try {
    db.exec("ALTER TABLE delegation_config ADD COLUMN " + col);
  } catch {}
});

// ── Migration douce — delegation_entries
// Recréer la table sans NOT NULL sur owner_id si nécessaire
try {
  const info = db.prepare("PRAGMA table_info(delegation_entries)").all();
  const ownerCol = info.find((c) => c.name === "owner_id");
  if (!ownerCol) {
    // Colonne manquante, l'ajouter
    db.exec("ALTER TABLE delegation_entries ADD COLUMN owner_id INTEGER");
  } else if (ownerCol.notnull) {
    // owner_id est NOT NULL → recréer la table sans cette contrainte
    db.exec(`
      CREATE TABLE IF NOT EXISTS delegation_entries_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        taker_id    INTEGER NOT NULL REFERENCES users(id),
        owner_id    INTEGER,
        is_pool     INTEGER DEFAULT 0,
        hours       REAL    NOT NULL,
        date        TEXT    NOT NULL,
        description TEXT,
        created_by  INTEGER REFERENCES users(id),
        created_at  TEXT    DEFAULT (datetime('now'))
      );
      INSERT INTO delegation_entries_new (id,taker_id,owner_id,is_pool,hours,date,description,created_by,created_at)
        SELECT id,taker_id,owner_id,COALESCE(is_pool,0),hours,date,description,created_by,created_at
        FROM delegation_entries;
      DROP TABLE delegation_entries;
      ALTER TABLE delegation_entries_new RENAME TO delegation_entries;
    `);
    console.log(
      "[Migration] delegation_entries recréée sans NOT NULL sur owner_id",
    );
  }
  // Ajouter is_pool si manquant
  try {
    db.exec(
      "ALTER TABLE delegation_entries ADD COLUMN is_pool INTEGER DEFAULT 0",
    );
  } catch {}
} catch (e) {
  console.error("[Migration entries]", e.message);
}

// Garantir qu'il y a toujours une ligne de config
try {
  db.prepare("INSERT OR IGNORE INTO delegation_config (id) VALUES (1)").run();
} catch {}

// ── Mailer Brevo / SMTP — optionnel, ne bloque jamais ────────────────────────
async function sendMail({ to, subject, html }) {
  try {
    const cfg = db.prepare("SELECT * FROM delegation_config WHERE id=1").get();
    // Si pas configuré, on sort silencieusement
    if (
      !cfg ||
      !cfg.smtp_host ||
      !cfg.smtp_user ||
      !cfg.smtp_pass ||
      !cfg.rh_email
    ) {
      console.log("[Mail] Config SMTP absente — email non envoyé");
      return;
    }
    const transporter = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: cfg.smtp_port || 587,
      secure: false,
      auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
      tls: { rejectUnauthorized: false }, // compatibilité Brevo
    });
    await transporter.sendMail({
      from: `"CSE Connect" <${cfg.smtp_user}>`,
      to: cfg.rh_email,
      subject,
      html,
    });
    console.log(`[Mail] ✅ Email envoyé à ${cfg.rh_email}`);
  } catch (e) {
    // Jamais bloquant — juste un log
    console.error("[Mail] ⚠️ Erreur envoi email (non bloquant):", e.message);
  }
}

// ── Notifications in-app ──────────────────────────────────────────────────────
function createNotification(userId, title, body, type = "info", link = "") {
  try {
    db.prepare(
      "INSERT INTO notifications (user_id, title, body, type, link) VALUES (?,?,?,?,?)",
    ).run(userId, title, body, type, link);
  } catch (e) {
    console.error("[Notif]", e.message);
  }
}

// ── Récupérer les membres actifs (pending=0 OU sans colonne pending) ────────
function getActiveMembers() {
  try {
    // Essaie avec pending
    const all = db
      .prepare(
        "SELECT id, name, avatar, role, titulaire, pending FROM users ORDER BY name ASC",
      )
      .all();
    // Filtre : pending=0 (validé) ou pending=null (colonne absente → inclus)
    return all.filter((u) => !u.pending);
  } catch {
    // Fallback si colonne pending absente
    try {
      return db
        .prepare(
          "SELECT id, name, avatar, role, COALESCE(titulaire,1) as titulaire FROM users ORDER BY name ASC",
        )
        .all();
    } catch {
      return [];
    }
  }
}

// ── Calcul solde titulaire ────────────────────────────────────────────────────
function computeBalance(userId, year, month) {
  try {
    const cfg = db.prepare("SELECT * FROM delegation_config WHERE id=1").get();
    if (!cfg) return null;

    const monthStr = `${year}-${String(month).padStart(2, "0")}`;
    const [py, pm] = month === 1 ? [year - 1, 12] : [year, month - 1];
    const prevStr = `${py}-${String(pm).padStart(2, "0")}`;

    // Déterminer si on est au-delà du premier mois de démarrage
    const startY = cfg.start_year || 0;
    const startM = cfg.start_month || 0;
    // isFirstMonth = on est exactement sur le mois de démarrage configuré,
    // OU aucun mois de démarrage n'est configuré (startY=0) ET aucune saisie
    // hasAnyEntry = vraies prises d'heures (pas les ajustements admin en négatif)
    const hasAnyEntry =
      db
        .prepare(
          "SELECT COUNT(*) as n FROM delegation_entries WHERE owner_id=? AND is_pool=0 AND hours > 0 AND (description NOT LIKE '[Ajustement admin%' OR description IS NULL)",
        )
        .get(userId).n > 0;
    const isBeforeStart =
      startY > 0 && (year < startY || (year === startY && month <= startM));
    const isStartMonth = startY > 0 && year === startY && month === startM;
    const noStartSet = startY === 0;

    // Pas de report si : mois de démarrage ou avant, OU pas de config ET pas d'historique
    const skipReport =
      isBeforeStart || isStartMonth || (noStartSet && !hasAnyEntry);

    let report = 0;
    if (!skipReport) {
      // Report du mois précédent
      const prevTaken =
        db
          .prepare(
            `SELECT COALESCE(SUM(hours),0) as h FROM delegation_entries WHERE owner_id=? AND is_pool=0 AND date LIKE ?`,
          )
          .get(userId, `${prevStr}%`).h || 0;
      const prevOut =
        db
          .prepare(
            `SELECT COALESCE(SUM(hours),0) as h FROM delegation_transfers WHERE from_id=? AND date LIKE ? AND status='approved'`,
          )
          .get(userId, `${prevStr}%`).h || 0;
      const prevIn =
        db
          .prepare(
            `SELECT COALESCE(SUM(hours),0) as h FROM delegation_transfers WHERE to_id=? AND date LIKE ? AND status='approved'`,
          )
          .get(userId, `${prevStr}%`).h || 0;
      const prevRem =
        (cfg.hours_titulaire || 20) - prevTaken - prevOut + prevIn;
      report = Math.min(
        Math.max(prevRem, 0),
        (cfg.max_report || 30) - (cfg.hours_titulaire || 20),
      );
    }

    const total = (cfg.hours_titulaire || 20) + report;
    // SUM(hours) inclut les ajustements négatifs (crédits admin)
    const taken =
      db
        .prepare(
          `SELECT COALESCE(SUM(hours),0) as h FROM delegation_entries WHERE owner_id=? AND is_pool=0 AND date LIKE ?`,
        )
        .get(userId, `${monthStr}%`).h || 0;
    const out =
      db
        .prepare(
          `SELECT COALESCE(SUM(hours),0) as h FROM delegation_transfers WHERE from_id=? AND date LIKE ? AND status='approved'`,
        )
        .get(userId, `${monthStr}%`).h || 0;
    const inn =
      db
        .prepare(
          `SELECT COALESCE(SUM(hours),0) as h FROM delegation_transfers WHERE to_id=? AND date LIKE ? AND status='approved'`,
        )
        .get(userId, `${monthStr}%`).h || 0;

    const safeTotal = Number(total) || cfg.hours_titulaire || 20;
    const safeTaken = Number(taken) || 0;
    const safeOut = Number(out) || 0;
    const safeIn = Number(inn) || 0;
    const safeRemaining = Math.max(safeTotal - safeTaken - safeOut + safeIn, 0);
    return {
      allocated: Number(cfg.hours_titulaire) || 20,
      reported: Number(report) || 0,
      total: safeTotal,
      taken: safeTaken,
      transferred_out: safeOut,
      transferred_in: safeIn,
      remaining: safeRemaining,
    };
  } catch (e) {
    console.error("[computeBalance]", e.message);
    return null;
  }
}

// ── Pot commun suppléants ─────────────────────────────────────────────────────
function poolBalance(year, month) {
  try {
    const cfg = db.prepare("SELECT * FROM delegation_config WHERE id=1").get();
    const monthStr = `${year}-${String(month).padStart(2, "0")}`;
    let sups = [];
    try {
      const all = db.prepare("SELECT id, titulaire, pending FROM users").all();
      sups = all.filter((u) => !u.titulaire && !u.pending);
    } catch {
      sups = [];
    }
    // Le pot commun est FIXE = hours_suppleant (7h), indépendant du nombre de suppléants
    // Les suppléants se partagent ce pot fixe, ils ne l'augmentent pas
    const total = cfg?.hours_suppleant || 7;
    const taken =
      db
        .prepare(
          `SELECT COALESCE(SUM(hours),0) as h FROM delegation_entries WHERE is_pool=1 AND date LIKE ?`,
        )
        .get(`${monthStr}%`).h || 0;
    return {
      total,
      taken,
      remaining: Math.max(total - taken, 0),
      count: sups.length,
      hours_each: cfg?.hours_suppleant || 7,
    };
  } catch (e) {
    console.error("[poolBalance]", e.message);
    return { total: 0, taken: 0, remaining: 0, count: 0, hours_each: 7 };
  }
}

// ── GET /config ───────────────────────────────────────────────────────────────
router.get("/config", auth, (req, res) => {
  try {
    const cfg = db
      .prepare(
        "SELECT id,hours_titulaire,hours_suppleant,max_report,rh_email,smtp_host,smtp_port,smtp_user,updated_at FROM delegation_config WHERE id=1",
      )
      .get();
    res.json(
      cfg || {
        hours_titulaire: 20,
        hours_suppleant: 7,
        max_report: 30,
        rh_email: "",
        smtp_host: "",
        smtp_port: 587,
        smtp_user: "",
      },
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /config ─────────────────────────────────────────────────────────────
router.patch("/config", auth, (req, res) => {
  if (!req.user.is_admin)
    return res.status(403).json({ error: "Réservé à l'admin" });
  const {
    hours_titulaire,
    hours_suppleant,
    max_report,
    start_year,
    start_month,
    rh_email,
    smtp_host,
    smtp_port,
    smtp_user,
    smtp_pass,
  } = req.body;
  try {
    const fields = {
      hours_titulaire,
      hours_suppleant,
      max_report,
      rh_email,
      smtp_host,
      smtp_port,
      smtp_user,
    };
    if (start_year !== undefined) fields.start_year = parseInt(start_year) || 0;
    if (start_month !== undefined)
      fields.start_month = parseInt(start_month) || 0;
    if (smtp_pass) fields.smtp_pass = smtp_pass;

    const sets = Object.keys(fields)
      .map((k) => `${k} = @${k}`)
      .join(", ");
    db.prepare(
      `UPDATE delegation_config SET ${sets}, updated_at = datetime('now') WHERE id = 1`,
    ).run(fields);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /summary ──────────────────────────────────────────────────────────────
router.get("/summary", auth, (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const members = getActiveMembers();
    const result = members.map((u) => ({
      user: {
        id: u.id,
        name: u.name,
        avatar: u.avatar,
        role: u.role,
        titulaire: !!u.titulaire,
      },
      balance: u.titulaire ? computeBalance(u.id, year, month) : null,
    }));
    res.json({ members: result, pool: poolBalance(year, month), year, month });
  } catch (e) {
    console.error("[summary]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /entries ──────────────────────────────────────────────────────────────
router.get("/entries", auth, (req, res) => {
  try {
    const { year, month, user_id } = req.query;
    const monthStr =
      year && month ? `${year}-${String(month).padStart(2, "0")}` : null;
    let query = `
      SELECT e.*, t.name as taker_name, t.avatar as taker_avatar,
             o.name as owner_name, o.avatar as owner_avatar, c.name as creator_name
      FROM delegation_entries e
      JOIN users t ON t.id = e.taker_id
      LEFT JOIN users o ON o.id = e.owner_id
      LEFT JOIN users c ON c.id = e.created_by
    `;
    const params = [],
      conds = [];
    if (monthStr) {
      conds.push("e.date LIKE ?");
      params.push(`${monthStr}%`);
    }
    if (user_id) {
      conds.push("(e.taker_id=? OR e.owner_id=?)");
      params.push(user_id, user_id);
    }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    query += " ORDER BY e.date DESC, e.created_at DESC";
    res.json(db.prepare(query).all(...params));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /entries ─────────────────────────────────────────────────────────────
router.post("/entries", auth, async (req, res) => {
  try {
    const { taker_id, owner_id, is_pool, hours, date, description } = req.body;
    if (!taker_id || !hours || !date)
      return res
        .status(400)
        .json({ error: "Bénéficiaire, heures et date requis" });
    if (parseFloat(hours) <= 0)
      return res
        .status(400)
        .json({ error: "Les heures doivent être positives" });

    const pool = !!is_pool;
    const h = parseFloat(hours);
    const [y, m] = date.split("-").map(Number);

    // Vérif solde — uniquement si le calcul réussit et donne un résultat cohérent
    if (pool) {
      const p = poolBalance(y, m);
      // Vérifier seulement si on a un solde positif calculé
      if (p && p.total > 0 && h > p.remaining)
        return res
          .status(400)
          .json({
            error: `Pot commun insuffisant : ${p.remaining}h disponibles sur ${p.total}h`,
          });
    } else {
      const ownerId = parseInt(owner_id || taker_id);
      const bal = computeBalance(ownerId, y, m);
      // Ne bloquer que si le solde est calculé ET cohérent (total > 0)
      if (bal && bal.total > 0 && h > bal.remaining)
        return res
          .status(400)
          .json({
            error: `Solde insuffisant pour ce compteur : ${bal.remaining}h disponibles sur ${bal.total}h`,
          });
    }

    const result = db
      .prepare(
        "INSERT INTO delegation_entries (taker_id, owner_id, is_pool, hours, date, description, created_by) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        parseInt(taker_id),
        pool ? null : parseInt(owner_id || taker_id),
        pool ? 1 : 0,
        h,
        date,
        description || "",
        req.user.id,
      );

    // Notifications in-app à tous
    const taker = db.prepare("SELECT name FROM users WHERE id=?").get(taker_id);
    const ownerLabel = pool
      ? "pot commun"
      : db
          .prepare("SELECT name FROM users WHERE id=?")
          .get(owner_id || taker_id)?.name || "—";
    const body = `${taker?.name} : ${hours}h sur ${ownerLabel} le ${date}${description ? " — " + description : ""}`;
    const allUsers = getActiveMembers();
    allUsers.forEach((u) =>
      createNotification(
        u.id,
        "⏱ Prise d'heures",
        body,
        "delegation",
        "/delegation",
      ),
    );

    // Mail RH — non bloquant
    sendMail({
      subject: `[CSE] Prise d'heures — ${taker?.name}`,
      html: `<p>Bonjour,</p><p>Une prise d'heures a été enregistrée :</p>
        <ul><li><b>Bénéficiaire :</b> ${taker?.name}</li>
        <li><b>Compteur :</b> ${ownerLabel}</li>
        <li><b>Heures :</b> ${hours}h</li>
        <li><b>Date :</b> ${date}</li>
        ${description ? `<li><b>Motif :</b> ${description}</li>` : ""}</ul>
        <p>Cordialement,<br>CSE Connect</p>`,
    });

    res.status(201).json({ id: result.lastInsertRowid, success: true });
  } catch (e) {
    console.error("[POST entries]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /entries/:id ───────────────────────────────────────────────────────
router.delete("/entries/:id", auth, (req, res) => {
  try {
    const e = db
      .prepare("SELECT * FROM delegation_entries WHERE id=?")
      .get(req.params.id);
    if (!e) return res.status(404).json({ error: "Introuvable" });
    if (e.created_by !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: "Non autorisé" });
    db.prepare("DELETE FROM delegation_entries WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /transfers ────────────────────────────────────────────────────────────
router.get("/transfers", auth, (req, res) => {
  try {
    res.json(
      db
        .prepare(
          `
      SELECT dt.*, f.name as from_name, f.avatar as from_avatar, t.name as to_name, t.avatar as to_avatar
      FROM delegation_transfers dt
      JOIN users f ON f.id = dt.from_id
      JOIN users t ON t.id = dt.to_id
      ORDER BY dt.created_at DESC LIMIT 100
    `,
        )
        .all(),
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /transfers ───────────────────────────────────────────────────────────
router.post("/transfers", auth, (req, res) => {
  try {
    const { from_id, to_id, hours, date, note } = req.body;
    if (!from_id || !to_id || !hours || !date)
      return res.status(400).json({ error: "Champs requis manquants" });
    const result = db
      .prepare(
        "INSERT INTO delegation_transfers (from_id, to_id, hours, date, note, status) VALUES (?,?,?,?,?,?)",
      )
      .run(
        parseInt(from_id),
        parseInt(to_id),
        parseFloat(hours),
        date,
        note || "",
        "pending",
      );
    const toUser = db.prepare("SELECT name FROM users WHERE id=?").get(to_id);
    createNotification(
      parseInt(from_id),
      "🔄 Demande de mutualisation",
      `${toUser?.name} demande ${hours}h de votre compteur`,
      "warning",
      "/delegation",
    );
    res.status(201).json({ id: result.lastInsertRowid, status: "pending" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /transfers/:id ──────────────────────────────────────────────────────
router.patch("/transfers/:id", auth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["approved", "rejected"].includes(status))
      return res.status(400).json({ error: "Statut invalide" });
    const t = db
      .prepare("SELECT * FROM delegation_transfers WHERE id=?")
      .get(req.params.id);
    if (!t) return res.status(404).json({ error: "Introuvable" });
    if (t.from_id !== req.user.id && !req.user.is_admin)
      return res.status(403).json({ error: "Non autorisé" });
    db.prepare("UPDATE delegation_transfers SET status=? WHERE id=?").run(
      status,
      req.params.id,
    );

    const fromUser = db
      .prepare("SELECT name FROM users WHERE id=?")
      .get(t.from_id);
    const toUser = db.prepare("SELECT name FROM users WHERE id=?").get(t.to_id);
    const label = status === "approved" ? "approuvée ✅" : "refusée ❌";
    createNotification(
      t.to_id,
      `Mutualisation ${label}`,
      `${fromUser?.name} a ${status === "approved" ? "approuvé" : "refusé"} ${t.hours}h`,
      status === "approved" ? "success" : "error",
      "/delegation",
    );

    if (status === "approved") {
      sendMail({
        subject: "[CSE] Mutualisation d'heures approuvée",
        html: `<p>Bonjour,</p><p>Une mutualisation a été approuvée :</p>
          <ul><li><b>De :</b> ${fromUser?.name}</li><li><b>À :</b> ${toUser?.name}</li>
          <li><b>Heures :</b> ${t.hours}h</li><li><b>Date :</b> ${t.date}</li>
          ${t.note ? `<li><b>Motif :</b> ${t.note}</li>` : ""}</ul>
          <p>Cordialement,<br>CSE Connect</p>`,
      });
    }
    res.json({ success: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /notifications ────────────────────────────────────────────────────────
router.get("/notifications", auth, (req, res) => {
  try {
    // Purger les notifications lues de plus de 7 jours
    db.prepare(
      "DELETE FROM notifications WHERE user_id=? AND read=1 AND created_at < datetime('now','-7 days')",
    ).run(req.user.id);
    // Retourner uniquement les non lues + les lues récentes (< 1h, pour feedback immédiat)
    res.json(
      db
        .prepare(
          `
      SELECT * FROM notifications
      WHERE user_id=?
        AND (read=0 OR created_at > datetime('now','-1 hour'))
      ORDER BY created_at DESC LIMIT 50
    `,
        )
        .all(req.user.id),
    );
  } catch {
    res.json([]);
  }
});

router.patch("/notifications/:id/read", auth, (req, res) => {
  try {
    db.prepare("UPDATE notifications SET read=1 WHERE id=? AND user_id=?").run(
      req.params.id,
      req.user.id,
    );
  } catch {}
  res.json({ success: true });
});

router.patch("/notifications/read-all", auth, (req, res) => {
  try {
    db.prepare("UPDATE notifications SET read=1 WHERE user_id=?").run(
      req.user.id,
    );
  } catch {}
  res.json({ success: true });
});

// ── GET /entries/all — Admin : toutes les entrées tous mois ──────────────────
router.get("/entries/all", auth, (req, res) => {
  if (!req.user.is_admin)
    return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    const entries = db
      .prepare(
        `
      SELECT e.*, t.name as taker_name, t.avatar as taker_avatar,
             o.name as owner_name, c.name as creator_name
      FROM delegation_entries e
      JOIN users t ON t.id = e.taker_id
      LEFT JOIN users o ON o.id = e.owner_id
      LEFT JOIN users c ON c.id = e.created_by
      ORDER BY e.date DESC, e.created_at DESC
    `,
      )
      .all();
    res.json(entries);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /entries/:id — Admin : modifier une entrée ─────────────────────────
router.patch("/entries/:id", auth, (req, res) => {
  if (!req.user.is_admin)
    return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    const entry = db
      .prepare("SELECT * FROM delegation_entries WHERE id=?")
      .get(req.params.id);
    if (!entry) return res.status(404).json({ error: "Entrée introuvable" });
    const { hours, date, description, owner_id, is_pool } = req.body;
    db.prepare(
      `UPDATE delegation_entries SET
      hours       = COALESCE(?, hours),
      date        = COALESCE(?, date),
      description = COALESCE(?, description),
      owner_id    = CASE WHEN ? IS NOT NULL THEN ? ELSE owner_id END,
      is_pool     = COALESCE(?, is_pool)
      WHERE id = ?
    `,
    ).run(
      hours || null,
      date || null,
      description || null,
      owner_id || null,
      owner_id || null,
      is_pool != null ? is_pool : null,
      req.params.id,
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /entries/admin — Admin : saisie forcée sans vérif solde ──────────────
router.post("/entries/admin", auth, (req, res) => {
  if (!req.user.is_admin)
    return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    const { taker_id, owner_id, is_pool, hours, date, description } = req.body;
    if (!taker_id || !hours || !date)
      return res
        .status(400)
        .json({ error: "Bénéficiaire, heures et date requis" });

    const result = db
      .prepare(
        "INSERT INTO delegation_entries (taker_id, owner_id, is_pool, hours, date, description, created_by) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        parseInt(taker_id),
        is_pool ? null : parseInt(owner_id || taker_id),
        is_pool ? 1 : 0,
        parseFloat(hours),
        date,
        description || "[Correction admin]",
        req.user.id,
      );
    res.status(201).json({ id: result.lastInsertRowid, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /adjust — Admin : ajustement manuel ────────────────────────────────
router.post("/adjust", auth, (req, res) => {
  if (!req.user.is_admin)
    return res.status(403).json({ error: "Réservé à l'admin" });
  try {
    const { user_id, target_hours, month, year, note } = req.body;
    if (!user_id || target_hours === undefined)
      return res.status(400).json({ error: "user_id et target_hours requis" });

    const y = parseInt(year) || new Date().getFullYear();
    const m = parseInt(month) || new Date().getMonth() + 1;
    const adjustDate = `${y}-${String(m).padStart(2, "0")}-15`;

    const current = computeBalance(parseInt(user_id), y, m);
    const currentRemaining = current ? Number(current.remaining) : 20;
    const target = parseFloat(target_hours);

    if (Math.abs(target - currentRemaining) < 0.01)
      return res.json({
        success: true,
        message: "Déjà à la bonne valeur",
        new_remaining: currentRemaining,
      });

    const description =
      note || `[Ajustement admin : ${currentRemaining}h → ${target}h]`;
    // diff > 0 = augmenter le solde = crédit = heures négatives dans entries (réduit le "pris")
    // diff < 0 = réduire le solde = débit = heures positives dans entries
    const diff = target - currentRemaining;
    const entryHours = diff > 0 ? -Math.abs(diff) : Math.abs(diff);

    db.prepare(
      "INSERT INTO delegation_entries (taker_id, owner_id, is_pool, hours, date, description, created_by) VALUES (?,?,0,?,?,?,?)",
    ).run(
      parseInt(user_id),
      parseInt(user_id),
      entryHours,
      adjustDate,
      description,
      req.user.id,
    );

    const newBalance = computeBalance(parseInt(user_id), y, m);
    res.json({
      success: true,
      previous: currentRemaining,
      target,
      new_remaining: newBalance ? Number(newBalance.remaining) : target,
    });
  } catch (e) {
    console.error("[adjust]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
