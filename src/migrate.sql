const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway 내부망(postgres.railway.internal)은 SSL 불필요
  // 외부 접속(Public URL) 사용 시엔 ssl: { rejectUnauthorized: false }
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : process.env.DATABASE_URL
      ? { rejectUnauthorized: false }
      : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('DB 연결 오류:', err.message);
});

async function checkConnection() {
  const client = await pool.connect();
  const res = await client.query('SELECT NOW() AS now, version() AS version');
  client.release();
  return res.rows[0];
}

module.exports = { pool, checkConnection };
