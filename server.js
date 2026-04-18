// server.js — Point d'entrée du serveur CSE
const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const cors      = require('cors');
const path      = require('path');
const jwt       = require('jsonwebtoken');
const db        = require('./db');

const SECRET = process.env.JWT_SECRET || 'cse-secret-key-changez-moi-en-prod';
const PORT   = process.env.PORT || 3001;

const app    = express();
const server = http.createServer(app);

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fichiers uploadés accessibles publiquement (optionnel)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── CHARGEMENT DES ROUTES AVEC DIAGNOSTIC ────────────────────────────────────
function loadRoute(name, filepath) {
  try {
    const route = require(filepath);
    if (typeof route !== 'function' && typeof route.handle !== 'function') {
      console.error(`❌ ERREUR : ${filepath} n'exporte pas un router Express valide`);
      console.error(`   Type reçu : ${typeof route}`);
      process.exit(1);
    }
    console.log(`✅ Route chargée : /api/${name}`);
    return route;
  } catch (e) {
    console.error(`❌ Impossible de charger ${filepath} :`, e.message);
    process.exit(1);
  }
}

// ─── ROUTES REST ───────────────────────────────────────────────────────────────
app.use('/api/auth',      loadRoute('auth',      './routes/auth'));
app.use('/api/messages',  loadRoute('messages',  './routes/messages'));
app.use('/api/notes',     loadRoute('notes',     './routes/notes'));
app.use('/api/meetings',  loadRoute('meetings',  './routes/meetings'));
app.use('/api/documents', loadRoute('documents', './routes/documents'));
app.use('/api/themes',     loadRoute('themes',      './routes/themes'));
app.use('/api/delegation', loadRoute('delegation', './routes/delegation'));
const { router: pushRouter, sendPush } = require('./routes/push');
app.use('/api/push', pushRouter);
// Rendre sendPush disponible globalement
global.sendPush = sendPush;
// Rendre sendPush disponible globalement pour les autres routes
global.sendPush = sendPush;

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── SOCKET.IO — MESSAGERIE TEMPS RÉEL ────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
});

// Authentification Socket.io via token JWT
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token manquant'));
  try {
    socket.user = jwt.verify(token, SECRET);
    next();
  } catch {
    next(new Error('Token invalide'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;
  console.log(`🔌 ${user.name} connecté (socket: ${socket.id})`);

  // Rejoindre un canal
  socket.on('join_channel', (channelName) => {
    socket.rooms.forEach(room => {
      if (room !== socket.id) socket.leave(room);
    });
    socket.join(`channel:${channelName}`);
    console.log(`   → ${user.name} rejoint #${channelName}`);
  });

  // Envoyer un message
  socket.on('send_message', ({ channelName, text }) => {
    if (!text?.trim()) return;

    const channel = db.prepare('SELECT * FROM channels WHERE name = ?').get(channelName);
    if (!channel) return socket.emit('error', 'Canal introuvable');

    const result = db.prepare(
      'INSERT INTO messages (channel_id, user_id, text) VALUES (?, ?, ?)'
    ).run(channel.id, user.id, text.trim());

    const message = {
      id: result.lastInsertRowid,
      text: text.trim(),
      created_at: new Date().toISOString(),
      user: { id: user.id, name: user.name, avatar: user.avatar, role: user.role },
    };

    // Diffuser à tous les membres du canal (émetteur inclus)
    io.to(`channel:${channelName}`).emit('new_message', { channelName, message });
  });

  // Indicateur "est en train d'écrire"
  socket.on('typing', ({ channelName, isTyping }) => {
    socket.to(`channel:${channelName}`).emit('user_typing', {
      channelName,
      user: { id: user.id, name: user.name },
      isTyping,
    });
  });

  socket.on('disconnect', () => {
    console.log(`🔌 ${user.name} déconnecté`);
  });
});

// ─── DÉMARRAGE ─────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Serveur CSE démarré sur http://localhost:${PORT}`);
  console.log(`📡 WebSocket actif`);
  console.log(`\nEndpoints disponibles :`);
  console.log(`  POST   /api/auth/login`);
  console.log(`  GET    /api/auth/me`);
  console.log(`  GET    /api/auth/users`);
  console.log(`  GET    /api/messages/:channel`);
  console.log(`  POST   /api/messages/:channel`);
  console.log(`  GET    /api/notes`);
  console.log(`  POST   /api/notes`);
  console.log(`  PATCH  /api/notes/:id`);
  console.log(`  DELETE /api/notes/:id`);
  console.log(`  GET    /api/meetings`);
  console.log(`  POST   /api/meetings`);
  console.log(`  PATCH  /api/meetings/:id`);
  console.log(`  DELETE /api/meetings/:id`);
  console.log(`  POST   /api/meetings/:id/attend`);
  console.log(`  GET    /api/documents`);
  console.log(`  POST   /api/documents`);
  console.log(`  GET    /api/documents/:id/download`);
  console.log(`  DELETE /api/documents/:id`);
});
