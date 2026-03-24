const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// 内存存储
const rooms = new Map();
const users = new Map();
const transactions = [];

// 自动清理：24小时无活动删除房间
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 每1小时检查一次
const MAX_INACTIVE_HOURS = 24; // 24小时无活动删除

function cleanupOldRooms() {
  const now = Date.now();
  const inactiveThreshold = MAX_INACTIVE_HOURS * 60 * 60 * 1000; // 24小时
  let deletedCount = 0;

  for (const [roomId, room] of rooms.entries()) {
    const lastActivity = new Date(room.last_activity || room.created_at).getTime();
    if (now - lastActivity > inactiveThreshold) {
      // 删除房间内所有用户
      for (const [userId, user] of users.entries()) {
        if (user.room_id === roomId) {
          users.delete(userId);
        }
      }
      // 删除房间
      rooms.delete(roomId);
      deletedCount++;
      console.log(`自动删除房间: ${roomId}`);
    }
  }

  if (deletedCount > 0) {
    console.log(`本次清理删除 ${deletedCount} 个房间`);
  }
}

// 启动时执行一次清理
cleanupOldRooms();
// 定时清理
setInterval(cleanupOldRooms, CLEANUP_INTERVAL);

app.use(cors());
app.use(express.json());

// 更新房间最后活动时间
function updateRoomActivity(roomId) {
  const room = rooms.get(roomId);
  if (room) {
    room.last_activity = new Date().toISOString();
  }
}

// 创建房间
app.post('/api/rooms', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '房间名称不能为空' });

  const id = uuidv4().slice(0, 8);
  const now = new Date().toISOString();
  rooms.set(id, { id, name, total_credits: 0, created_at: now, last_activity: now });

  res.json({ id, name, total_credits: 0 });
});

// 获取房间信息
app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: '房间不存在' });

  // 更新活动时间
  room.last_activity = new Date().toISOString();

  const roomUsers = Array.from(users.values())
    .filter(u => u.room_id === req.params.id)
    .map(u => ({ id: u.id, name: u.name, credits: u.credits }));

  res.json({ ...room, users: roomUsers });
});

// 加入房间
app.post('/api/rooms/:id/join', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '用户名不能为空' });

  const room = rooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: '房间不存在' });

  // 更新活动时间
  room.last_activity = new Date().toISOString();

  // 检查是否已存在用户
  const existingUser = Array.from(users.values()).find(
    u => u.room_id === req.params.id && u.name === name
  );
  if (existingUser) {
    return res.json(existingUser);
  }

  const id = uuidv4().slice(0, 8);
  const user = { id, room_id: req.params.id, name, credits: 0, created_at: new Date().toISOString() };
  users.set(id, user);

  res.json(user);
});

// 投入积分
app.post('/api/users/:id/deposit', (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '投入积分必须大于0' });

  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 更新房间活动时间
  updateRoomActivity(user.room_id);

  // 允许积分为负数
  const balance_before = user.credits;
  const balance_after = user.credits - amount;
  user.credits = balance_after;

  // 更新房间总积分
  const room = rooms.get(user.room_id);
  if (room) room.total_credits += amount;

  // 记录交易
  transactions.push({
    id: uuidv4().slice(0, 8),
    room_id: user.room_id,
    user_id: user.id,
    type: 'deposit',
    amount,
    balance_before,
    balance_after,
    created_at: new Date().toISOString()
  });

  res.json({ success: true, balance: balance_after });
});

// 取出积分
app.post('/api/users/:id/withdraw', (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '取出积分必须大于0' });

  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 更新房间活动时间
  updateRoomActivity(user.room_id);

  const room = rooms.get(user.room_id);
  if (!room || room.total_credits < amount) {
    return res.status(400).json({ error: '积分池余额不足' });
  }

  const balance_before = user.credits;
  const balance_after = user.credits + amount;
  user.credits = balance_after;

  // 更新房间总积分
  room.total_credits -= amount;

  // 记录交易
  transactions.push({
    id: uuidv4().slice(0, 8),
    room_id: user.room_id,
    user_id: user.id,
    type: 'withdraw',
    amount,
    balance_before,
    balance_after,
    created_at: new Date().toISOString()
  });

  res.json({ success: true, balance: balance_after });
});

// 获取用户信息
app.get('/api/users/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(user);
});

// 获取交易记录
app.get('/api/rooms/:id/transactions', (req, res) => {
  const roomTx = transactions
    .filter(t => t.room_id === req.params.id)
    .map(t => {
      const user = users.get(t.user_id);
      return { ...t, user_name: user ? user.name : '未知' };
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 50);

  res.json(roomTx);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`服务器运行在端口 ${PORT}`);
  console.log(`自动清理：${MAX_INACTIVE_HOURS}小时无活动房间将被删除`);
});