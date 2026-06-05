const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.static(__dirname));
app.use(express.json());
app.get('/firebase-messaging-sw.js', (req, res) => {
  res.sendFile(__dirname + '/firebase-messaging-sw.js');
});
// Memory: track who is in which channel
// { channelName: { socketId: username } }
const channelMembers = {};
const fcmTokens = {};
// ===== AUTH =====
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRef = db.collection('users').doc(username);
    const doc = await userRef.get();
    if (doc.exists) return res.json({ success: false, message: 'Username sudah dipakai!' });
    const hashed = await bcrypt.hash(password, 10);
    await userRef.set({ username, password: hashed, createdAt: new Date(), lastActive: new Date(), isAdmin: false });
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const userRef = db.collection('users').doc(username);
    const doc = await userRef.get();
    if (!doc.exists) return res.json({ success: false, message: 'Username tidak ditemukan!' });
    const user = doc.data();
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.json({ success: false, message: 'Password salah!' });
    if (user.banned) return res.json({ success: false, message: 'Akun kamu telah dibanned!' });
    await userRef.update({ lastActive: new Date() });
    res.json({ success: true, username, isAdmin: user.isAdmin });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// ===== CHANNEL API =====
// Get all channels
app.get('/channels', async (req, res) => {
  try {
    const snap = await db.collection('channels').get();
    const channels = snap.docs.map(doc => {
      const d = doc.data();
      const members = channelMembers[doc.id] ? Object.values(channelMembers[doc.id]) : [];
      return { id: doc.id, name: d.name, type: d.type, description: d.description || '', memberCount: members.length, members };
    });
    res.json({ success: true, channels });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// Create channel
app.post('/channels', async (req, res) => {
  const { name, type, password, description, createdBy } = req.body;
  if (!name || !type) return res.json({ success: false, message: 'Nama dan tipe wajib diisi!' });
  const channelId = name.toLowerCase().replace(/\s+/g, '-');
  try {
    const ref = db.collection('channels').doc(channelId);
    const doc = await ref.get();
    if (doc.exists) return res.json({ success: false, message: 'Channel sudah ada!' });
    const data = { name: channelId, type, description: description || '', createdBy, createdAt: new Date() };
    if (type === 'private' && password) {
      data.password = await bcrypt.hash(password, 10);
    }
    await ref.set(data);
    res.json({ success: true, channel: { id: channelId, name: channelId, type, description: description || '', memberCount: 0, members: [] } });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// Verify channel password
app.post('/channels/verify', async (req, res) => {
  const { channelId, password } = req.body;
  try {
    const doc = await db.collection('channels').doc(channelId).get();
    if (!doc.exists) return res.json({ success: false, message: 'Channel tidak ditemukan!' });
    const data = doc.data();
    if (data.type !== 'private') return res.json({ success: true });
    if (!data.password) return res.json({ success: true });
    const match = await bcrypt.compare(password, data.password);
    res.json({ success: match, message: match ? '' : 'Sandi salah!' });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// ===== ADMIN API =====

// Helper: cek apakah user adalah admin
async function checkAdmin(username) {
  const doc = await db.collection('users').doc(username).get();
  if (!doc.exists) return false;
  return doc.data().isAdmin === true;
}

// Kick user dari channel
app.post('/admin/kick', async (req, res) => {
  const { adminUsername, targetUsername, channelId } = req.body;
  try {
    if (!(await checkAdmin(adminUsername))) {
      return res.json({ success: false, message: 'Bukan admin!' });
    }
    // Cari socket ID dari targetUsername di channel
    if (channelMembers[channelId]) {
      const targetSocketId = Object.keys(channelMembers[channelId]).find(
        sid => channelMembers[channelId][sid] === targetUsername
      );
      if (targetSocketId) {
        io.to(targetSocketId).emit('kicked', { channel: channelId, reason: 'Dikeluarkan oleh admin' });
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          targetSocket.leave(channelId);
          delete channelMembers[channelId][targetSocketId];
          const members = Object.values(channelMembers[channelId]);
          io.to(channelId).emit('channel_members', members);
          io.emit('channel_update', { channelId, memberCount: members.length, members });
        }
        return res.json({ success: true, message: `${targetUsername} telah dikick dari ${channelId}` });
      }
    }
    res.json({ success: false, message: 'User tidak ditemukan di channel!' });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// Ban user dari aplikasi
app.post('/admin/ban', async (req, res) => {
  const { adminUsername, targetUsername } = req.body;
  try {
    if (!(await checkAdmin(adminUsername))) {
      return res.json({ success: false, message: 'Bukan admin!' });
    }
    const userRef = db.collection('users').doc(targetUsername);
    const doc = await userRef.get();
    if (!doc.exists) return res.json({ success: false, message: 'User tidak ditemukan!' });
    if (doc.data().isAdmin) return res.json({ success: false, message: 'Tidak bisa ban admin!' });
    await userRef.update({ banned: true });
    // Kick dari semua channel yang sedang diikuti
    for (const [chId, members] of Object.entries(channelMembers)) {
      const targetSocketId = Object.keys(members).find(sid => members[sid] === targetUsername);
      if (targetSocketId) {
        io.to(targetSocketId).emit('banned', { reason: 'Kamu telah dibanned oleh admin' });
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          targetSocket.leave(chId);
          delete channelMembers[chId][targetSocketId];
          const updatedMembers = Object.values(channelMembers[chId]);
          io.to(chId).emit('channel_members', updatedMembers);
          io.emit('channel_update', { channelId: chId, memberCount: updatedMembers.length, members: updatedMembers });
        }
      }
    }
    res.json({ success: true, message: `${targetUsername} telah dibanned` });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// Unban user
app.post('/admin/unban', async (req, res) => {
  const { adminUsername, targetUsername } = req.body;
  try {
    if (!(await checkAdmin(adminUsername))) {
      return res.json({ success: false, message: 'Bukan admin!' });
    }
    const userRef = db.collection('users').doc(targetUsername);
    const doc = await userRef.get();
    if (!doc.exists) return res.json({ success: false, message: 'User tidak ditemukan!' });
    await userRef.update({ banned: false });
    res.json({ success: true, message: `${targetUsername} telah di-unban` });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// Hapus channel
app.delete('/admin/channel/:channelId', async (req, res) => {
  const { adminUsername } = req.body;
  const { channelId } = req.params;
  try {
    if (!(await checkAdmin(adminUsername))) {
      return res.json({ success: false, message: 'Bukan admin!' });
    }
    await db.collection('channels').doc(channelId).delete();
    // Kick semua user dari channel
    if (channelMembers[channelId]) {
      io.to(channelId).emit('channel_deleted', { channelId });
      delete channelMembers[channelId];
    }
    io.emit('channel_removed', { channelId });
    res.json({ success: true, message: `Channel ${channelId} telah dihapus` });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// Get all users (admin only)
app.get('/admin/users', async (req, res) => {
  const { adminUsername } = req.query;
  try {
    if (!(await checkAdmin(adminUsername))) {
      return res.json({ success: false, message: 'Bukan admin!' });
    }
    const snap = await db.collection('users').get();
    const users = snap.docs.map(doc => {
      const d = doc.data();
      return { username: d.username, isAdmin: d.isAdmin || false, banned: d.banned || false, createdAt: d.createdAt };
    });
    res.json({ success: true, users });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log('User terhubung:', socket.id);
  let currentChannel = null;
  let currentUsername = null;
  let isTalking = false;

  socket.on('set_username', (username) => { currentUsername = username; });
socket.on('register_fcm_token', ({username, token}) => {
  fcmTokens[username] = token;
  console.log('FCM token registered:', username);
});
function leaveCurrentChannel() {
    if (currentChannel) {
      socket.to(currentChannel).emit('user_stop_talking'); // ← TAMBAH INI
      socket.leave(currentChannel);
      if (channelMembers[currentChannel]) {
        delete channelMembers[currentChannel][socket.id];
        const members = Object.values(channelMembers[currentChannel]);
        io.to(currentChannel).emit('channel_members', members);
        io.emit('channel_update', { channelId: currentChannel, memberCount: members.length, members });
      }
      currentChannel = null;
    }
  }

  socket.on('join_channel', ({ channel, username }) => {
    leaveCurrentChannel();
    currentChannel = channel;
    currentUsername = username || currentUsername;
    socket.join(channel);
    if (!channelMembers[channel]) channelMembers[channel] = {};
    channelMembers[channel][socket.id] = currentUsername;
    const members = Object.values(channelMembers[channel]);
    io.to(channel).emit('channel_members', members);
    io.emit('channel_update', { channelId: channel, memberCount: members.length, members });
    console.log(`${currentUsername} join: ${channel}`);
  });
socket.on('rejoin_channel', ({ channel, username }) => {
  currentChannel = channel;
  currentUsername = username || currentUsername;
  socket.join(channel);
  if (!channelMembers[channel]) channelMembers[channel] = {};
  channelMembers[channel][socket.id] = currentUsername;
  const members = Object.values(channelMembers[channel]);
  io.to(channel).emit('channel_members', members);
  io.emit('channel_update', { channelId: channel, memberCount: members.length, members });
});
  socket.on('emergency_start', async (username) => {
  io.emit('emergency_alert', {username});
  const onlineSockets = await io.fetchSockets();
  const onlineUsers = onlineSockets.map(s => s.data?.username || '');
  for(const [user, token] of Object.entries(fcmTokens)) {
    if(!onlineUsers.includes(user) && user !== username) {
      await admin.messaging().send({
        token,
        notification: {
          title: '🚨 EMERGENCY!',
          body: username.toUpperCase() + ' membutuhkan bantuan!'
        }
      }).catch(err => console.log('FCM error:', err));
    }
  }
});

socket.on('emergency_data', (data) => {
  io.emit('emergency_voice', data.audio);
});

socket.on('emergency_end', (username) => {
  io.emit('emergency_stop', {username});
});
  socket.on('leave_channel', () => { leaveCurrentChannel(); });

socket.on('voice_data', (data) => {
    if (!isTalking) {
      isTalking = true;
      socket.to(data.channel).emit('user_talking', currentUsername);
    }
    socket.to(data.channel).emit('voice_data', data.audio);
  });
  socket.on('voice_end', (channel) => {
    isTalking = false;
    socket.to(channel).emit('user_stop_talking');
  });
  socket.on('disconnect', () => {
    console.log('User keluar:', socket.id);
    leaveCurrentChannel();
  });
});

server.listen(3000, () => console.log('Server berjalan di port 3000'));
