// db.js — เชื่อมต่อ Postgres ของ Mailnot (แยกจาก Boxxland Auth, คนละ database)
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres ต้องการ SSL
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mailnot_users (
      discord_id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mailnot_messages (
      id SERIAL PRIMARY KEY,
      from_discord_id TEXT NOT NULL,
      to_discord_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );
  `);
}

init().catch((err) => console.error('DB init error:', err));

module.exports = pool;
