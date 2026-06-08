// server.js — Point d'entrée CSE (PostgreSQL/Supabase)
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const path       = require('path');
const jwt        = require('jsonwebtoken');
const { query, getOne, insert } = require('./db');

const SECRET = process.env.JWT_SECRET || 'cse-connect2026';
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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── CHARGEMENT ROUTES ─────────────────────────────────────────────────────────
function loadRoute(name, filepath) {
  try {
    const route = require(filepath);
    if (typeof route !== 'function' && typeof route.handle !== 'function') {
      console.error(`❌ ${filepath} n'exporte pas un router Express valide`);
      process.exit(1);
    }
    console.log(`✅ Route chargée : /api/${name}`);
    return route;
  } catch (e) {
    console.error(`❌ Impossible de charger ${filepath} :`, e.message);
    process.exit(1);
  }
}

app.use('/api/auth',       loadRoute('auth',       './routes/auth'));
app.use('/api/messages',   loadRoute('messages',   './routes/messages'));
app.use('/api/notes',      loadRoute('notes',      './routes/notes'));
app.use('/api/meetings',   loadRoute('meetings',   './routes/meetings'));
app.use('/api/documents',  loadRoute('documents',  './routes/documents'));
app.use('/api/themes',     loadRoute('themes',     './routes/themes'));
app.use('/api/delegation', loadRoute('delegation', './routes/delegation'));

const { router: pushRouter, sendPush } = require('./routes/push');
app.use('/api/push', pushRouter);
global.sendPush = sendPush;

// ─── HEALTH CHECK + PING (pour UptimeRobot / keep-alive Supabase) ──────────────
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Route ping — garde Supabase éveillé (appeler toutes les 48h via UptimeRobot)
app.get('/api/ping', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, pong: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Route debug — test insertion notification
app.get('/api/debug/notif', async (req, res) => {
  try {
    const users = await query('SELECT id FROM users WHERE pending = FALSE LIMIT 1');
    if (!users.rows.length) return res.json({ ok: false, error: 'Aucun utilisateur' });
    const userId = users.rows[0].id;
    await query(
      'INSERT INTO notifications (user_id, title, body, type, link) VALUES ($1,$2,$3,$4,$5)',
      [userId, 'Test notification', 'Si tu vois ca les notifications fonctionnent', 'info', '/chat']
    );
    res.json({ ok: true, user_id: userId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── SOCKET.IO — MESSAGERIE TEMPS RÉEL ────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  },
});

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
  console.log(`🔌 ${user.name} connecté`);

  socket.on('join_channel', (channelName) => {
    socket.rooms.forEach(room => { if (room !== socket.id) socket.leave(room); });
    socket.join(`channel:${channelName}`);
  });

  socket.on('send_message', async ({ channelName, text }) => {
    if (!text?.trim()) return;
    try {
      const channel = await getOne('SELECT * FROM channels WHERE name = $1', [channelName]);
      if (!channel) return socket.emit('error', 'Canal introuvable');

      const id = await insert(
        'INSERT INTO messages (channel_id, user_id, text) VALUES ($1,$2,$3)',
        [channel.id, user.id, text.trim()]
      );

      const message = {
        id,
        text: text.trim(),
        created_at: new Date().toISOString(),
        user: { id: user.id, name: user.name, avatar: user.avatar, role: user.role },
      };

      // Notifier tous les membres sauf l'auteur
      const { notifyAll } = require('./notifier');
      notifyAll(
        `💬 #${channelName}`,
        `${user.name} : ${text.trim().slice(0, 80)}${text.trim().length > 80 ? '…' : ''}`,
        'info', '/chat', user.id
      ).catch(() => {});
      io.to(`channel:${channelName}`).emit('new_message', { channelName, message });
    } catch (e) {
      console.error('[socket send_message]', e.message);
    }
  });

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
  console.log(`🗄️  Base de données : PostgreSQL/Supabase`);
  console.log(`❤️  Health check : /api/health`);
  console.log(`🏓 Ping Supabase  : /api/ping`);
});
