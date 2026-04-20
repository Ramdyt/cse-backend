// routes/documents.js — PostgreSQL + stockage local (uploads/)
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { query, getOne, getAll, insert } = require('../db');
const { auth } = require('../middleware/auth');
const { notifyAll } = require('../notifier');

const router = express.Router();

// Dossier uploads — dans le répertoire du projet (Render Free sans disque persistant)
// Note : les fichiers sont perdus au redémarrage sur Render Free.
// Pour la persistance des fichiers, utiliser Supabase Storage (upgrade futur).
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ALLOWED = ['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.txt','.csv','.png','.jpg','.jpeg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED.includes(ext)) cb(null, true);
    else cb(new Error('Type de fichier non autorisé'));
  },
});

function getIcon(filename) {
  const ext = path.extname(filename).toLowerCase();
  const icons = { '.pdf':'📄','.doc':'📝','.docx':'📝','.xls':'📊','.xlsx':'📊','.csv':'📊','.ppt':'📺','.pptx':'📺','.png':'🖼','.jpg':'🖼','.jpeg':'🖼','.txt':'📋' };
  return icons[ext] || '📁';
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024*1024) return `${(bytes/1024).toFixed(0)} KB`;
  return `${(bytes/(1024*1024)).toFixed(1)} MB`;
}

const DOC_SELECT = `
  SELECT d.id, d.name, d.filename, d.size, d.category, d.icon, d.created_at,
         u.id as uploader_id, u.name as uploader_name, u.avatar
  FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
`;

// GET /api/documents
router.get('/', auth, async (req, res) => {
  try {
    const { category, search } = req.query;
    const conditions = [], params = [];
    if (category) { params.push(category); conditions.push(`d.category = $${params.length}`); }
    if (search)   { params.push(`%${search}%`); conditions.push(`d.name ILIKE $${params.length}`); }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const docs = await getAll(DOC_SELECT + where + ' ORDER BY d.created_at DESC', params);
    res.json(docs.map(d => ({
      id: d.id, name: d.name, filename: d.filename,
      size: formatSize(d.size), category: d.category, icon: d.icon,
      created_at: d.created_at,
      uploadedBy: { id: d.uploader_id, name: d.uploader_name, avatar: d.avatar },
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/documents
router.post('/', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    const { category = 'Divers' } = req.body;
    const icon = getIcon(req.file.originalname);
    const id = await insert(
      'INSERT INTO documents (name, filename, size, category, icon, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [req.file.originalname, req.file.filename, req.file.size, category, icon, req.user.id]
    );
    const doc = await getOne(DOC_SELECT + ' WHERE d.id = $1', [id]);
    notifyAll('📁 Nouveau document', `${req.file.originalname} ajouté par ${req.user.name}`, 'info', '/docs', req.user.id).catch(() => {});
    res.status(201).json({
      id: doc.id, name: doc.name, filename: doc.filename,
      size: formatSize(doc.size), category: doc.category, icon: doc.icon,
      created_at: doc.created_at,
      uploadedBy: { id: doc.uploader_id, name: doc.uploader_name, avatar: doc.avatar },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/documents/:id/download
router.get('/:id/download', (req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
}, auth, async (req, res) => {
  try {
    const doc = await getOne('SELECT * FROM documents WHERE id = $1', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });
    const filepath = path.join(UPLOAD_DIR, doc.filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Fichier non trouvé sur le serveur' });
    const ext = path.extname(doc.filename).toLowerCase();
    const openInBrowser = ['.pdf','.png','.jpg','.jpeg','.gif','.webp','.txt'];
    if (openInBrowser.includes(ext)) {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.name)}"`);
      res.sendFile(filepath);
    } else {
      res.download(filepath, doc.name);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/documents/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const doc = await getOne('SELECT * FROM documents WHERE id = $1', [req.params.id]);
    if (!doc) return res.status(404).json({ error: 'Document introuvable' });
    const filepath = path.join(UPLOAD_DIR, doc.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    await query('DELETE FROM documents WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
