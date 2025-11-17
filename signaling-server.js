/**
 * Signaling server for P2P connections using Socket.IO + Express
 * - Safe startup/shutdown handlers
 * - Single PORT declaration (uses process.env.PORT if provided)
 * - Basic in-memory room bookkeeping (no file upload/store on server)
 *
 * Replace your current signaling-server.js with this file.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

/* ----------------------------- Config / Globals ---------------------------- */
const PORT = process.env.PORT || 3000;
const APP_NAME = 'p2p-signaling';

// Room structure:
// rooms = Map<roomCode, { hostSocketId, peers: Set<socketId>, roomName }>
const rooms = new Map();

// Simple rate-bucket map to avoid spamming (basic)
const rateBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = 500; // min interval between messages per socket

/* ------------------------------- Express App -------------------------------- */
const app = express();
app.get('/', (req, res) => {
  res.send(`${APP_NAME} signaling server is healthy`);
});

const server = http.createServer(app);

/* ------------------------------- Socket.IO --------------------------------- */
const io = new Server(server, {
  cors: {
    origin: '*', // tighten in production to your app's origin
    methods: ['GET', 'POST']
  },
  // pingInterval/pingTimeout can be tuned if needed
});

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // helper: rate limit
  function allowNow() {
    const last = rateBuckets.get(socket.id) || 0;
    const now = Date.now();
    if (now - last < RATE_LIMIT_WINDOW_MS) return false;
    rateBuckets.set(socket.id, now);
    return true;
  }

  // create room
  socket.on('create-room', (opts = {}, cb) => {
    try {
      if (!allowNow()) return cb && cb({ ok: false, reason: 'rate_limited' });

      // room code: 6 chars base36
      const code = (Math.random().toString(36).slice(2, 8) || Date.now().toString(36).slice(-6)).toUpperCase();
      const meta = {
        hostSocketId: socket.id,
        peers: new Set(),
        roomName: `room-${code}`
      };
      rooms.set(code, meta);
      socket.join(meta.roomName);
      console.log('room created', code, 'by', socket.id);
      cb && cb({ ok: true, code });
    } catch (err) {
      console.error('create-room err', err);
      cb && cb({ ok: false, reason: 'error' });
    }
  });

  // join room
  socket.on('join-room', (payload = {}, cb) => {
    try {
      if (!allowNow()) return cb && cb({ ok: false, reason: 'rate_limited' });

      const { code } = payload;
      if (!code || !rooms.has(code)) return cb && cb({ ok: false, reason: 'room_not_found' });

      const meta = rooms.get(code);
      // enforce max peers if you want (optional)
      meta.peers.add(socket.id);
      socket.join(meta.roomName);

      // notify host that a peer joined
      io.to(meta.hostSocketId).emit('peer-joined', { peerId: socket.id, code });
      console.log('peer joined', socket.id, 'to', code);

      cb && cb({ ok: true, hostId: meta.hostSocketId, code });
    } catch (err) {
      console.error('join-room err', err);
      cb && cb({ ok: false, reason: 'error' });
    }
  });

  // forward signaling messages: offer/answer/candidate/custom
  socket.on('signal', (data = {}) => {
    try {
      if (!allowNow()) return;
      const { to, payload } = data;
      if (!to) return;
      io.to(to).emit('signal', { from: socket.id, payload });
    } catch (err) {
      console.error('signal err', err);
    }
  });

  // host can start transfer or send custom events to all peers in room
  socket.on('host-event', (data = {}) => {
    try {
      if (!allowNow()) return;
      const { code, eventName, payload } = data;
      const meta = rooms.get(code);
      if (!meta) return;
      io.to(meta.roomName).emit(eventName, { from: socket.id, payload });
    } catch (err) {
      console.error('host-event err', err);
    }
  });

  // leave room (client asks to leave)
  socket.on('leave-room', (data = {}) => {
    try {
      const { code } = data;
      const meta = rooms.get(code);
      if (!meta) return;
      // remove peer or if host left, remove room
      if (meta.hostSocketId === socket.id) {
        io.to(meta.roomName).emit('host-left', { code });
        // close room
        rooms.delete(code);
        io.in(meta.roomName).socketsLeave(meta.roomName);
        console.log('host left, room removed', code);
      } else if (meta.peers.has(socket.id)) {
        meta.peers.delete(socket.id);
        socket.leave(meta.roomName);
        io.to(meta.hostSocketId).emit('peer-left', { peerId: socket.id, code });
        console.log('peer left', socket.id, 'from', code);
      }
    } catch (err) {
      console.error('leave-room err', err);
    }
  });

  // disconnect handling
  socket.on('disconnect', (reason) => {
    try {
      console.log('disconnect', socket.id, 'reason', reason);
      // cleanup any rooms referencing this socket
      for (const [code, meta] of rooms.entries()) {
        if (meta.hostSocketId === socket.id) {
          // notify peers and remove room
          io.to(meta.roomName).emit('host-left', { code });
          rooms.delete(code);
          io.in(meta.roomName).socketsLeave(meta.roomName);
          console.log('room removed (host disconnected):', code);
        } else if (meta.peers.has(socket.id)) {
          meta.peers.delete(socket.id);
          // inform host
          io.to(meta.hostSocketId).emit('peer-left', { peerId: socket.id, code });
          console.log('peer removed on disconnect', socket.id, 'from', code);
        }
      }
      // cleanup bucket
      rateBuckets.delete(socket.id);
    } catch (err) {
      console.error('disconnect err', err);
    }
  });
});

/* --------------------------- Error / Safety Handlers ------------------------- */
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err && err.stack ? err.stack : err);
  // do not exit forcibly here: allow graceful handlers to run or restart platform
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION', reason);
});

/* ------------------------------- Shutdown ---------------------------------- */
const shutdown = (signal) => {
  console.warn(`Received ${signal} - shutting down gracefully...`);
  try {
    server.close(() => {
      console.log('HTTP server closed.');
      process.exit(0);
    });

    // Force exit if not closed in time
    setTimeout(() => {
      console.error('Force exit after shutdown timeout.');
      process.exit(1);
    }, 10000).unref();
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* ------------------------------- Start Server ------------------------------- */
server.listen(PORT, () => {
  console.log(`${APP_NAME} listening on PORT:`, PORT);
});
