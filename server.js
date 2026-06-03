const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');

// Baca dari env variable (Railway) atau file lokal (Termux)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./serviceAccount.json');
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

// Memory: track who is in which channel
// { channelName: { socketId: username } }
const channelMembers = {};

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

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log('User terhubung:', socket.id);
  let currentChannel = null;
  let currentUsername = null;

  socket.on('set_username', (username) => { currentUsername = username; });

  function leaveCurrentChannel() {
    if (currentChannel) {
      socket.leave(currentChannel);
      if (channelMembers[currentChannel]) {
        delete channelMembers[currentChannel][socket.id];
        const members = Object.values(channelMembers[currentChannel]);
        io.to(currentChannel).emit('channel_members', members);
        // Broadcast updated channel list
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

  socket.on('leave_channel', () => { leaveCurrentChannel(); });

  socket.on('voice_data', (data) => {
    socket.to(data.channel).emit('user_talking', currentUsername);
    socket.to(data.channel).emit('voice_data', data.audio);
  });

  socket.on('voice_end', (channel) => { socket.to(channel).emit('user_stop_talking'); });

  socket.on('disconnect', () => {
    console.log('User keluar:', socket.id);
    leaveCurrentChannel();
  });
});

server.listen(3000, () => console.log('Server berjalan di port 3000'));
