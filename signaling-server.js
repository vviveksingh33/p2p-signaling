// robust Socket.IO signaling server — no file storage
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.get('/', (req, res) => res.send('P2P signaling server (healthy)'));

const rooms = new Map();
function genCode(len = 6) {
  return Math.random().toString(36).slice(2, 2 + len).toUpperCase();
}

function safe(fn){
  return function(...args){
    try { return fn.apply(this, args); }
    catch(err){ console.error('Handler error:', err && err.stack ? err.stack : err); }
  };
}

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('create', safe((opts = {}, cb = () => {}) => {
    const code = genCode();
    rooms.set(code, { host: socket.id, peers: new Set(), createdAt: Date.now(), opts });
    socket.join(code);
    console.log('room created', code, 'by', socket.id);
    cb({ ok: true, code, expiresAt: Date.now() + ((opts.ttlMinutes||60)*60000) });
  }));

  socket.on('join', safe((code, cb = () => {}) => {
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, msg: 'Room not found' });
    if ((room.opts && room.opts.maxPeers) && room.peers.size >= room.opts.maxPeers) return cb({ ok: false, msg: 'Max peers reached' });
    room.peers.add(socket.id);
    socket.join(code);
    io.to(room.host).emit('peer-joined', { peer: socket.id, code });
    console.log('peer joined', socket.id, 'in', code);
    cb({ ok: true });
  }));

  socket.on('signal', safe(({ code, to, data }) => {
    if (to) io.to(to).emit('signal', { from: socket.id, data });
    else if (code) socket.to(code).emit('signal', { from: socket.id, data });
  }));

  socket.on('transfer-complete', safe(({ code, peerId }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (typeof room.usageLeft === 'number') {
      room.usageLeft = Math.max(0, (room.usageLeft || 0) - 1);
      console.log('usage decremented for', code, room.usageLeft);
      if (room.usageLeft === 0) {
        io.to(code).emit('room-expired', { code, reason: 'usage_exhausted' });
        rooms.delete(code);
      }
    }
  }));

  socket.on('disconnect', () => {
    console.log('socket disconnected', socket.id);
    for (const [code, r] of rooms.entries()) {
      if (r.host === socket.id) {
        io.to(code).emit('host-left', { code });
        rooms.delete(code);
        console.log('room removed due to host disconnect', code);
      } else if (r.peers.has(socket.id)) {
        r.peers.delete(socket.id);
      }
    }
  });
});

process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION', err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason, p) => {
  console.error('UNHANDLED REJECTION at:', p, 'reason:', reason);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening on', PORT));
