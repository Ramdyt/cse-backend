// routes/documents.js
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');
const { auth } = require('../middleware/auth');
const { notifyAll } = require('../notifier');

const router = express.Router();

// ─── CONFIGURATION MULTER (upload de fichiers) ────────────────────────────────
// En production sur Render : /data/uploads (disque persistant)
// En développement : dossier local uploads/
const UPLOAD_DIR = process.env.NODE_ENV === 'production'
  ? '/data/uploads'
  : path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_\-]/g, '_')
      .slice(0, 60);
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const ALLOWED = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.png', '.jpg', '.jpeg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED.includes(ext)) cb(null, true);
    else cb(new Error('Type de fichier non autorisé'));
  },
});

// Détermine l'icône selon l'extension
function getIcon(filename) {
  const ext = path.extname(filename).toLowerCase();
  const icons = {
    '.pdf': '📄', '.doc': '📝', '.docx': '📝',
    '.xls': '📊', '.xlsx': '📊', '.csv': '📊',
    '.ppt': '📺', '.pptx': '📺',
    '.png': '🖼', '.jpg': '🖼', '.jpeg': '🖼',
    '.txt': '📋',
  };
  return icons[ext] || '📁';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const DOC_SELECT = `
  SELECT d.id, d.name, d.filename, d.size, d.category, d.icon, d.created_at,
         u.id as uploader_id, u.name as uploader_name, u.avatar
  FROM documents d
  LEFT JOIN users u ON u.id = d.uploaded_by
`;

// GET /api/documents?category=PV&search=budget
router.get('/', auth, (req, res) => {
  const { category, search } = req.query;
  let query = DOC_SELECT;
  const params = [];
  const conditions = [];

  if (category) { conditions.push('d.category = ?'); params.push(category); }
  if (search)   { conditions.push('d.name LIKE ?'); params.push(`%${search}%`); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY d.created_at DESC';

  const docs = db.prepare(query).all(...params);
  res.json(docs.map(d => ({
    id: d.id, name: d.name, filename: d.filename,
    size: formatSize(d.size), category: d.category, icon: d.icon,
    created_at: d.created_at,
    uploadedBy: { id: d.uploader_id, name: d.uploader_name, avatar: d.avatar },
  })));
});

// POST /api/documents — upload d'un fichier
router.post('/', auth, upload.single('file'), (req, res) => {
  if (!req.file)
    return res.status(400).json({ error: 'Aucun fichier reçu' });

  const { category = 'Divers' } = req.body;
  const icon = getIcon(req.file.originalname);

  const result = db.prepare(
    'INSERT INTO documents (name, filename, size, category, icon, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.file.originalname, req.file.filename, req.file.size, category, icon, req.user.id);

  const doc = db.prepare(DOC_SELECT + ' WHERE d.id = ?').get(result.lastInsertRowid);
  notifyAll('📁 Nouveau document', `${req.file.originalname} ajouté par ${req.user.name}`, 'info', '/docs', req.user.id).catch(()=>{});
  res.status(201).json({
    id: doc.id, name: doc.name, filename: doc.filename,
    size: formatSize(doc.size), category: doc.category, icon: doc.icon,
    created_at: doc.created_at,
    uploadedBy: { id: doc.uploader_id, name: doc.uploader_name, avatar: doc.avatar },
  });
});

// GET /api/documents/:id/download — télécharger un fichier
// Accepte le token en header Authorization OU en query string ?token=
router.get('/:id/download', (req, res, next) => {
  // Si token en query string, l'injecter dans les headers pour que `auth` fonctionne
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, auth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document introuvable' });

  const filepath = path.join(UPLOAD_DIR, doc.filename);
  if (!fs.existsSync(filepath))
    return res.status(404).json({ error: 'Fichier non trouvé sur le serveur' });

  // Définir le bon Content-Type pour ouvrir dans le navigateur
  const ext = path.extname(doc.filename).toLowerCase();
  const openInBrowser = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt'];
  if (openInBrowser.includes(ext)) {
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.name)}"`);
    res.sendFile(filepath);
  } else {
    res.download(filepath, doc.name);
  }
});

// DELETE /api/documents/:id
router.delete('/:id', auth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document introuvable' });

  // Supprimer le fichier physique si il existe
  const filepath = path.join(UPLOAD_DIR, doc.filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);

  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
