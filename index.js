const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json());

// PostgreSQL 连接 (Neon)
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_zY9VfAdGOs8r@ep-withered-bonus-a12tlz3o-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
});

const PORT = process.env.PORT || 3000;

// 初始化数据库表
async function initDB() {
  const client = await pool.connect();
  try {
    // 创建房间表
    await client.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id VARCHAR(6) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        total_credits INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 创建用户表
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(10) PRIMARY KEY,
        room_id VARCHAR(6) NOT NULL,
        name VARCHAR(100) NOT NULL,
        credits INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      )
    `);

    // 创建交易记录表
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id VARCHAR(10) PRIMARY KEY,
        room_id VARCHAR(6) NOT NULL,
        user_id VARCHAR(10) NOT NULL,
        user_name VARCHAR(100) NOT NULL,
        type VARCHAR(10) NOT NULL,
        amount INTEGER NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      )
    `);

    console.log('数据库表初始化完成');
  } finally {
    client.release();
  }
}

// 生成6位数字房间号
function generateRoomId() {
  return Math.random().toString().slice(2, 8);
}

// 清理24小时无活动的房间
async function cleanupRooms() {
  const client = await pool.connect();
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await client.query('DELETE FROM rooms WHERE last_active < $1', [cutoff]);
    console.log('已清理24小时无活动的房间');
  } finally {
    client.release();
  }
}

// 创建房间
app.post('/api/rooms', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '房间名称不能为空' });

  let id = generateRoomId();
  const client = await pool.connect();
  try {
    // 确保房间号唯一
    let exists = true;
    while (exists) {
      const result = await client.query('SELECT id FROM rooms WHERE id = $1', [id]);
      exists = result.rows.length > 0;
      if (exists) id = generateRoomId();
    }

    await client.query(
      'INSERT INTO rooms (id, name, total_credits) VALUES ($1, $2, 0)',
      [id, name]
    );

    res.json({ id, name, total_credits: 0 });
  } catch (err) {
    console.error('创建房间错误:', err);
    res.status(500).json({ error: '创建房间失败' });
  } finally {
    client.release();
  }
});

// 获取房间信息
app.get('/api/rooms/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    // 更新最后活跃时间
    await client.query('UPDATE rooms SET last_active = CURRENT_TIMESTAMP WHERE id = $1', [id]);

    // 获取房间信息
    const roomResult = await client.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: '房间不存在' });
    }

    // 获取用户列表
    const usersResult = await client.query('SELECT * FROM users WHERE room_id = $1', [id]);

    const room = roomResult.rows[0];
    res.json({
      ...room,
      users: usersResult.rows
    });
  } catch (err) {
    console.error('获取房间错误:', err);
    res.status(500).json({ error: '获取房间失败' });
  } finally {
    client.release();
  }
});

// 加入房间
app.post('/api/rooms/:id/join', async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: '用户名不能为空' });

  const client = await pool.connect();
  try {
    // 检查房间是否存在
    const roomResult = await client.query('SELECT * FROM rooms WHERE id = $1', [id]);
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: '房间不存在' });
    }

    // 检查用户是否已存在
    const userExists = await client.query('SELECT * FROM users WHERE room_id = $1 AND name = $2', [id, name]);
    if (userExists.rows.length > 0) {
      return res.json(userExists.rows[0]);
    }

    // 创建用户
    const userId = uuidv4().slice(0, 8);
    await client.query(
      'INSERT INTO users (id, room_id, name, credits) VALUES ($1, $2, $3, 0)',
      [userId, id, name]
    );

    // 更新房间最后活跃时间
    await client.query('UPDATE rooms SET last_active = CURRENT_TIMESTAMP WHERE id = $1', [id]);

    res.json({
      id: userId,
      room_id: id,
      name,
      credits: 0
    });
  } catch (err) {
    console.error('加入房间错误:', err);
    res.status(500).json({ error: '加入房间失败' });
  } finally {
    client.release();
  }
});

// 投入积分 (deposit -> invest)
app.post('/api/users/:id/invest', async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '投入积分必须大于0' });

  const client = await pool.connect();
  try {
    // 获取用户信息
    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    const user = userResult.rows[0];

    // 更新用户积分 (投入是扣减，所以是负数)
    await client.query('UPDATE users SET credits = credits - $1 WHERE id = $2', [amount, id]);

    // 更新房间总积分
    await client.query('UPDATE rooms SET total_credits = total_credits + $1, last_active = CURRENT_TIMESTAMP WHERE id = $2', [amount, user.room_id]);

    // 记录交易
    const txId = uuidv4().slice(0, 8);
    await client.query(
      'INSERT INTO transactions (id, room_id, user_id, user_name, type, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [txId, user.room_id, id, user.name, 'invest', amount]
    );

    // 获取更新后的信息
    const updatedUser = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    const updatedRoom = await client.query('SELECT * FROM rooms WHERE id = $1', [user.room_id]);

    res.json({
      user: updatedUser.rows[0],
      room: updatedRoom.rows[0]
    });
  } catch (err) {
    console.error('投入积分错误:', err);
    res.status(500).json({ error: '投入积分失败' });
  } finally {
    client.release();
  }
});

// 取出积分
app.post('/api/users/:id/withdraw', async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: '取出积分必须大于0' });

  const client = await pool.connect();
  try {
    // 获取用户信息
    const userResult = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    const user = userResult.rows[0];

    // 检查积分池余额
    if (user.credits < amount) {
      return res.status(400).json({ error: '积分不足' });
    }

    // 更新用户积分 (取出是增加，所以是正数)
    await client.query('UPDATE users SET credits = credits + $1 WHERE id = $2', [amount, id]);

    // 更新房间总积分
    await client.query('UPDATE rooms SET total_credits = total_credits - $1, last_active = CURRENT_TIMESTAMP WHERE id = $2', [amount, user.room_id]);

    // 记录交易
    const txId = uuidv4().slice(0, 8);
    await client.query(
      'INSERT INTO transactions (id, room_id, user_id, user_name, type, amount) VALUES ($1, $2, $3, $4, $5, $6)',
      [txId, user.room_id, id, user.name, 'withdraw', amount]
    );

    // 获取更新后的信息
    const updatedUser = await client.query('SELECT * FROM users WHERE id = $1', [id]);
    const updatedRoom = await client.query('SELECT * FROM rooms WHERE id = $1', [user.room_id]);

    res.json({
      user: updatedUser.rows[0],
      room: updatedRoom.rows[0]
    });
  } catch (err) {
    console.error('取出积分错误:', err);
    res.status(500).json({ error: '取出积分失败' });
  } finally {
    client.release();
  }
});

// 获取交易记录
app.get('/api/rooms/:id/transactions', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM transactions WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('获取交易记录错误:', err);
    res.status(500).json({ error: '获取交易记录失败' });
  } finally {
    client.release();
  }
});

// 初始化数据库并启动服务器
initDB().then(() => {
  // 每小时清理一次无活动的房间
  setInterval(cleanupRooms, 60 * 60 * 1000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`服务器运行在端口 ${PORT}`);
    console.log('使用 Neon PostgreSQL 数据库');
    console.log('自动清理：24小时无活动房间将被删除');
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
