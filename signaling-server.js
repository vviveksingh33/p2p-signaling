const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map();
function genCode(len = 6) { return Math.random().toString(36).slice(2, 2 + len).toUpperCase(); }

io.on('connection', socket => {
  console.log('socket connected', socket.id);

  socket.on('create', (opts = {}, cb = () => {}) => {
    const code = genCode();
    rooms.set(code, { host: socket.id, peers: new Set() });
    socket.join(code);
    console.log('room created', code);
    cb({ ok: true, code });
  });

  socket.on('join', (code, cb = () => {}) => {
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, msg: 'Room not found' });
    room.peers.add(socket.id);
    socket.join(code);
    io.to(room.host).emit('peer-joined', { peer: socket.id, code });
    console.log('peer joined', socket.id, 'in', code);
    cb({ ok: true });
  });

  socket.on('signal', ({ code, to, data }) => {
    if (to) io.to(to).emit('signal', { from: socket.id, data });
    else if (code) socket.to(code).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    for (const [code, r] of rooms.entries()) {
      if (r.host === socket.id) { io.to(code).emit('host-left'); rooms.delete(code); }
      else r.peers.delete(socket.id);
    }
  });
});

app.get('/', (req, res) => res.send('Socket.IO signaling server running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening', PORT));
