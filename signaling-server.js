// signaling-server.js
// Production-minded Socket.IO signaling server with:
// - secure room token (join requires token)
// - TTL, maxPeers, usageLimit
// - per-socket rate limiting and connection limits
// - optional Redis adapter hint (commented)
// - Railway-ready: uses process.env.PORT

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);

// Basic configuration via env
const PORT = process.env.PORT || 3000;
const MAX_CONNECTIONS_PER_IP = parseInt(process.env.MAX_CONN_PER_IP || '10', 10);
const MSGS_PER_SECOND = parseInt(process.env.MSGS_PER_SECOND || '10', 10);
const ROOM_CODE_LEN = parseInt(process.env.ROOM_CODE_LEN || '7', 10);

// Optional: Redis adapter for socket.io when scaling. (requires @socket.io/redis-adapter)
// const { createAdapter } = require('@socket.io/redis-adapter');
// const { createClient } = require('redis');
// if (process.env.REDIS_URL) {
//   const pubClient = createClient({ url: process.env.REDIS_URL });
//   const subClient = pubClient.duplicate();
//   await pubClient.connect();
//   await subClient.connect();
//   io.adapter(createAdapter(pubClient, subClient));
// }

const io = new Server(server, {
  cors: { origin: '*' } // restrict origin in production
});

// Simple in-memory stores (replace with Redis for horizontal scale)
const rooms = new Map(); // roomCode -> { hostSocketId, token, peers:Set(socketId), createdAt, ttlMs, maxPeers, usageLeft }
const ipConnections = new Map(); // ip -> Set(socketId)

// In-memory rate limiter per socket: token bucket
const rateBuckets = new Map(); // socketId -> { tokens, lastRefill }

// Utility functions
function genCode(len = ROOM_CODE_LEN) {
  return crypto.randomBytes(Math.ceil(len * 3 / 4)).toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, len)
    .toUpperCase();
}
function genToken(len = 32) {
  return crypto.randomBytes(len).toString('hex');
}
function nowMs() { return Date.now(); }

// Room cleanup interval (TTL)
const CLEAN_INTERVAL_MS = 30 * 1000;
setInterval(() => {
  const now = nowMs();
  for (const [code, meta] of rooms.entries()) {
    if (meta.ttlMs && (meta.createdAt + meta.ttlMs) <= now) {
      io.to(meta.roomRoomName || code).emit('room-expired', { code, reason: 'ttl' });
      rooms.delete(code);
      console.log('room removed (ttl):', code);
    }
  }
}, CLEAN_INTERVAL_MS);

// Middleware-ish helpers
function addIpConnection(ip, socketId) {
  const s = ipConnections.get(ip) || new Set();
  s.add(socketId);
  ipConnections.set(ip, s);
}
function removeIpConnection(ip, socketId) {
  const s = ipConnections.get(ip);
  if (!s) return;
  s.delete(socketId);
  if (s.size === 0) ipConnections.delete(ip);
  else ipConnections.set(ip, s);
}
function getIpCount(ip) {
  const s = ipConnections.get(ip);
  return s ? s.size : 0;
}

// Rate bucket functions
function ensureBucket(socketId) {
  if (!rateBuckets.has(socketId)) {
    rateBuckets.set(socketId, { tokens: MSGS_PER_SECOND, lastRefill: nowMs() });
  }
  return rateBuckets.get(socketId);
}
function consumeToken(socketId) {
  const bucket = ensureBucket(socketId);
  const now = nowMs();
  const elapsed = (now - bucket.lastRefill) / 1000;
  if (elapsed > 0) {
    const refill = Math.min(MSGS_PER_SECOND, bucket.tokens + elapsed * MSGS_PER_SECOND);
    bucket.tokens = refill;
    bucket.lastRefill = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

// Health endpoint
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

io.on('connection', (socket) => {
  const ip = socket.handshake.address || socket.conn.remoteAddress || 'unknown';
  console.log('connect', socket.id, 'ip', ip);

  // Enforce per-IP connection limit
  addIpConnection(ip, socket.id);
  if (getIpCount(ip) > MAX_CONNECTIONS_PER_IP) {
    console.warn('ip connection limit reached for', ip);
    socket.emit('error', { code: 'ip_limit', message: 'Too many connections from this IP' });
    socket.disconnect(true);
    return;
  }

  // On create-room: opts = { ttlMinutes, maxPeers, usageLimit }
  socket.on('create-room', (opts = {}, cb = () => {}) => {
    try {
      if (!consumeToken(socket.id)) {
        return cb({ ok: false, error: 'rate_limit' });
      }

      const code = genCode();
      const token = genToken(16);
      const ttlMinutes = Math.max(1, parseInt(opts.ttlMinutes || 60, 10));
      const maxPeers = Math.max(1, parseInt(opts.maxPeers || 1, 10));
      const usageLeft = (typeof opts.usageLimit === 'number' && opts.usageLimit > 0) ? Math.floor(opts.usageLimit) : null;

      const meta = {
        hostSocketId: socket.id,
        token,
        peers: new Set(),
        createdAt: nowMs(),
        ttlMs: ttlMinutes * 60 * 1000,
        maxPeers,
        usageLeft,
        roomRoomName: `room-${code}` // socket.io room name
      };

      rooms.set(code, meta);
      socket.join(meta.roomRoomName);

      console.log('room created', code, 'host', socket.id, 'ttlMin', ttlMinutes, 'maxPeers', maxPeers, 'usageLeft', usageLeft);
      cb({ ok: true, code, token, ttlMinutes, maxPeers, usageLeft });
    } catch (err) {
      console.error('create-room error', err);
      cb({ ok: false, error: 'server_error' });
    }
  });

  // Join-room requires both code and token
  socket.on('join-room', (payload = {}, cb = () => {}) => {
    try {
      if (!consumeToken(socket.id)) {
        return cb({ ok: false, error: 'rate_limit' });
      }
      const { code, token } = payload;
      if (!code || !token) return cb({ ok: false, error: 'missing_params' });

      const meta = rooms.get(code);
      if (!meta) return cb({ ok: false, error: 'room_not_found' });
      if (meta.token !== token) return cb({ ok: false, error: 'invalid_token' });
      if (meta.maxPeers && meta.peers.size >= meta.maxPeers) return cb({ ok: false, error: 'max_peers_reached' });

      meta.peers.add(socket.id);
      socket.join(meta.roomRoomName);
      console.log('peer joined', socket.id, 'room', code);
      // Notify host
      io.to(meta.hostSocketId).emit('peer-joined', { peerId: socket.id, code });
      cb({ ok: true });
    } catch (err) {
      console.error('join-room error', err);
      cb({ ok: false, error: 'server_error' });
    }
  });

  // Signal relay: small payloads only
  // payload: { code, to(optional socketId), data }
  socket.on('signal', (payload = {}) => {
    try {
      if (!consumeToken(socket.id)) {
        socket.emit('error', { code: 'rate_limit' });
        return;
      }
      const { code, to, data } = payload;
      if (!code) return;
      const meta = rooms.get(code);
      if (!meta) return;

      // Sanity: ensure sender is part of room (host or peer)
      const isHost = meta.hostSocketId === socket.id;
      const isPeer = meta.peers.has(socket.id);
      if (!isHost && !isPeer) return;

      if (to) {
        io.to(to).emit('signal', { from: socket.id, data });
      } else {
        // broadcast to room except sender
        socket.to(meta.roomRoomName).emit('signal', { from: socket.id, data });
      }
    } catch (err) {
      console.error('signal error', err);
    }
  });

  // Transfer-complete: decrement usageLeft and possibly expire
  socket.on('transfer-complete', (payload = {}) => {
    try {
      const { code } = payload;
      const meta = rooms.get(code);
      if (!meta) return;
      if (typeof meta.usageLeft === 'number') {
        meta.usageLeft = Math.max(0, meta.usageLeft - 1);
        console.log('usage decremented', code, '->', meta.usageLeft);
        if (meta.usageLeft === 0) {
          io.to(meta.roomRoomName).emit('room-expired', { code, reason: 'usage_exhausted' });
          rooms.delete(code);
          console.log('room removed (usage exhausted):', code);
        }
      }
    } catch (err) {
      console.error('transfer-complete err', err);
    }
  });

  // Leave room
  socket.on('leave-room', (payload = {}) => {
    try {
      const { code } = payload;
      const meta = rooms.get(code);
      if (!meta) return;
      if (meta.peers.has(socket.id)) {
        meta.peers.delete(socket.id);
        socket.leave(meta.roomRoomName);
        console.log('peer left', socket.id, 'room', code);
      } else if (meta.hostSocketId === socket.id) {
        // host left -> close room
        io.to(meta.roomRoomName).emit('host-left', { code });
        rooms.delete(code);
        console.log('host left, room removed', code);
      }
    } catch (err) {
      console.error('leave-room err', err);
    }
  });

  socket.on('disconnect', (reason) => {
    try {
      console.log('disconnect', socket.id, 'reason', reason);
      removeIpConnection(ip, socket.id);
      // cleanup any rooms referencing this socket
      for (const [code, meta] of rooms.entries()) {
        if (meta.hostSocketId === socket.id) {
          io.to(meta.roomRoomName).emit('host-left', { code });
          rooms.delete(code);
          console.log('room removed (host disconnect):', code);
        } else if (meta.peers.has(socket.id)) {
          meta.peers.delete(socket.id);
          io.to(meta.hostSocketId).emit('peer-left', { peerId: socket.id, code });
        }
      }
      // cleanup rate bucket
      rateBuckets.delete(socket.id);
    } catch (err) {
      console.error('disconnect err', err);
    }
  });

});

// Safety handlers
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION', err && err.stack ? err.stack : err);
  // don't exit automatically — Railway will restart if needed
});
process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION', reason);
});

server.listen(PORT, () => {
  console.log('Signaling server running on PORT:', PORT);
});
