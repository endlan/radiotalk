const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server);

// Simpan daftar channel
const channels = {};

io.on('connection', (socket) => {
  console.log('User terhubung:', socket.id);

  // User gabung channel
  socket.on('join_channel', (channelName) => {
    socket.join(channelName);
    console.log(`User ${socket.id} gabung channel: ${channelName}`);
  });

  // User kirim suara (PTT)
  socket.on('voice_data', (data) => {
    // Kirim suara ke semua user di channel yang sama
    socket.to(data.channel).emit('voice_data', data.audio);
  });

  // User keluar
  socket.on('disconnect', () => {
    console.log('User keluar:', socket.id);
  });
});

server.listen(3000, () => {
  console.log('Server berjalan di port 3000');
});
