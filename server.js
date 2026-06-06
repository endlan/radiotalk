const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const emergencyCount = {};
const schedule = require('node-schedule');
// Reset hitungan setiap hari jam 00:00
schedule.scheduleJob('0 17 * * *', () => {
  Object.keys(emergencyCount).forEach(key => delete emergencyCount[key]);
  console.log('Emergency count reset');
});
let broadcastMessage = '';
const mutedUsers = new Set();
// PTT State
let pttState = {
  isBusy: false,
  talkingUser: null,
  cooldownUntil: 0,
  pttTimer: null
};

let pttDurasiDetik = 15;

// Track username per socket ID
const socketUserMap = {};

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
async function checkAdmin(username) {
  const doc = await db.collection('users').doc(username).get();
  if (!doc.exists) return false;
  return doc.data().isAdmin === true;
}

app.post('/admin/kick', async (req, res) => {
  const { adminUsername, targetUsername, channelId } = req.body;
  try {
    if (!(await checkAdmin(adminUsername))) {
      return res.json({ success: false, message: 'Bukan admin!' });
    }
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

app.delete('/admin/channel/:channelId', async (req, res) => {
  const { adminUsername } = req.body;
  const { channelId } = req.params;
  try {
    if (!(await checkAdmin(adminUsername))) {
      return res.json({ success: false, message: 'Bukan admin!' });
    }
    await db.collection('channels').doc(channelId).delete();
    if (channelMembers[channelId]) {
      io.to(channelId).emit('channel_deleted', { channelId });
      delete channelMembers[channelId];
    }
    io.emit('channel_removed', { channelId });
    res.json({ success: true, message: `Channel ${channelId} telah dihapus` });
  } catch (err) { res.json({ success: false, message: err.message }); }
});

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
  let pttLimitTimer = null;

  socket.on('set_username', (username) => {
    // Kick semua koneksi lama dengan username yang sama
    for (const [sid, uname] of Object.entries(socketUserMap)) {
      if (uname === username && sid !== socket.id) {
        const oldSocket = io.sockets.sockets.get(sid);
        if (oldSocket) {
          oldSocket.emit('kicked_duplicate', { reason: 'Akun kamu dibuka di perangkat lain' });
          oldSocket.disconnect(true);
        }
        delete socketUserMap[sid];
      }
    }
    socketUserMap[socket.id] = username;
    currentUsername = username;
    if(broadcastMessage) socket.emit('broadcast_update', broadcastMessage);
  });

  socket.on('register_fcm_token', ({username, token}) => {
    fcmTokens[username] = token;
    console.log('FCM token registered:', username);
  });

  socket.on('mute_user', (targetUsername) => {
    if(currentUsername !== 'Endri') return;
    mutedUsers.add(targetUsername);
    for(const [sid, socket2] of io.sockets.sockets) {
      if(channelMembers[currentChannel] && channelMembers[currentChannel][sid] === targetUsername) {
        socket2.emit('you_muted');
      }
    }
    io.emit('user_muted', targetUsername);
  });

  socket.on('unmute_user', (targetUsername) => {
    if(currentUsername !== 'Endri') return;
    mutedUsers.delete(targetUsername);
    io.emit('user_unmuted', targetUsername);
  });

  socket.on('broadcast_send', (pesan) => {
    if(currentUsername !== 'Endri') return;
    broadcastMessage = pesan;
    io.emit('broadcast_update', pesan);
  });

  socket.on('broadcast_clear', () => {
    if(currentUsername !== 'Endri') return;
    broadcastMessage = '';
    io.emit('broadcast_update', '');
  });

  socket.on('debug', (msg) => {
    console.log('DEBUG:', msg);
  });

  function leaveCurrentChannel() {
    if (currentChannel) {
      if (pttState.talkingUser === currentUsername) {
        pttState.isBusy = false;
        pttState.talkingUser = null;
        if (pttState.pttTimer) clearTimeout(pttState.pttTimer);
        pttState.pttTimer = null;
        pttState.cooldownUntil = Date.now() + 3000;
        setTimeout(() => { pttState.cooldownUntil = 0; }, 3000);
        socket.to(currentChannel).emit('user_stop_talking');
      }
      if (pttLimitTimer) { clearTimeout(pttLimitTimer); pttLimitTimer = null; }
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

  socket.on('emergency_start', async ({username, lat, lng}) => {
    if(username !== 'Endri') {
      if((emergencyCount[username] || 0) >= 2) {
        socket.emit('emergency_limit', 'Batas emergency harian sudah tercapai');
        return;
      }
      emergencyCount[username] = (emergencyCount[username] || 0) + 1;
    }
    io.emit('emergency_alert', {username});
    await admin.messaging().send({
      topic: 'emergency',
      notification: {
        title: '🚨 EMERGENCY!',
        body: username.toUpperCase() + ' membutuhkan bantuan!'
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'RadioTalkChannel'
        }
      }
    }).catch(err => console.log('FCM error:', err));
  });

  socket.on('emergency_data', (data) => {
    io.emit('emergency_voice', data.audio);
  });

  socket.on('emergency_end', (username) => {
    io.emit('emergency_stop', {username});
  });

  socket.on('reset_emergency', async ({ adminUsername, targetUsername }) => {
    const isAdmin = adminUsername === 'Endri' || await checkAdmin(adminUsername);
    if (!isAdmin) {
      socket.emit('reset_emergency_result', { success: false, message: 'Bukan admin!' });
      return;
    }
    delete emergencyCount[targetUsername];
    socket.emit('reset_emergency_result', { success: true, username: targetUsername });
    console.log(`Emergency limit reset for: ${targetUsername} by ${adminUsername}`);
  });

  socket.on('leave_channel', () => { leaveCurrentChannel(); });

  socket.on('set_ptt_durasi', async ({ adminUsername, detik }) => {
    const isAdmin = adminUsername === 'Endri' || await checkAdmin(adminUsername);
    if (!isAdmin) { socket.emit('set_ptt_durasi_result', { success: false, message: 'Bukan admin!' }); return; }
    const d = parseInt(detik);
    if (isNaN(d) || d < 5 || d > 60) { socket.emit('set_ptt_durasi_result', { success: false, message: 'Durasi harus 5-60 detik!' }); return; }
    pttDurasiDetik = d;
    socket.emit('set_ptt_durasi_result', { success: true, detik: pttDurasiDetik });
    console.log('PTT durasi diubah ke:', pttDurasiDetik, 'detik oleh', adminUsername);
  });

  socket.on('get_ptt_durasi', () => {
    socket.emit('ptt_durasi_info', { detik: pttDurasiDetik });
  });

  socket.on('get_emergency_counts', async ({ adminUsername }) => {
    const isAdmin = adminUsername === 'Endri' || await checkAdmin(adminUsername);
    if (!isAdmin) return;
    socket.emit('emergency_counts_info', { counts: emergencyCount });
  });

  socket.on('ptt_start', (channel) => {
    socket.to(channel).emit('user_talking', currentUsername);
  });

  socket.on('voice_data', (data) => {
    const now = Date.now();
    if(mutedUsers.has(currentUsername)) {
      socket.emit('ptt_rejected', { reason: 'muted' });
      return;
    }
    if (pttState.cooldownUntil > now) {
      const sisaMs = pttState.cooldownUntil - now;
      socket.emit('ptt_rejected', { reason: 'cooldown', sisaDetik: Math.ceil(sisaMs / 1000) });
      return;
    }
    if (pttState.isBusy && pttState.talkingUser !== currentUsername) {
      socket.emit('ptt_rejected', { reason: 'busy', talkingUser: pttState.talkingUser });
      return;
    }
    if (!isTalking) {
      isTalking = true;
      pttState.isBusy = true;
      pttState.talkingUser = currentUsername;
      socket.to(data.channel).emit('user_talking', currentUsername);
      if (pttState.pttTimer) clearTimeout(pttState.pttTimer);
      pttState.pttTimer = setTimeout(() => {
        socket.emit('ptt_timeout');
        isTalking = false;
        pttState.isBusy = false;
        pttState.talkingUser = null;
        pttState.pttTimer = null;
        pttState.cooldownUntil = Date.now() + 3000;
        io.to(data.channel).emit('user_stop_talking');
        setTimeout(() => { pttState.cooldownUntil = 0; }, 3000);
      }, pttDurasiDetik * 1000);
    }
    socket.to(data.channel).emit('voice_data', data.audio);
  });

  socket.on('voice_end', (channel) => {
    if (!isTalking) return;
    isTalking = false;
    if (pttState.talkingUser === currentUsername) {
      pttState.isBusy = false;
      pttState.talkingUser = null;
      if (pttState.pttTimer) { clearTimeout(pttState.pttTimer); pttState.pttTimer = null; }
      pttState.cooldownUntil = Date.now() + 3000;
      setTimeout(() => { pttState.cooldownUntil = 0; }, 3000);
    }
    socket.to(channel).emit('user_stop_talking');
  });

  socket.on('disconnect', () => {
    console.log('User keluar:', socket.id);
    delete socketUserMap[socket.id];
    leaveCurrentChannel();
  });
});

server.listen(3000, () => console.log('Server berjalan di port 3000'));
