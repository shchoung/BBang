/**
 * 실행: node src/db/migrate.js
 * PostGIS 확장 활성화 + 전체 테이블 생성
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, checkConnection } = require('./pool');

async function migrate() {
  console.log('🔌 DB 연결 확인 중...');

  const info = await checkConnection();
  console.log('✅ 연결 성공:', info.now);
  console.log('   PostgreSQL:', info.version.split(' ').slice(0, 2).join(' '));

  const sql = fs.readFileSync(path.join(__dirname, 'migrate.sql'), 'utf8');

  console.log('\n📦 마이그레이션 실행 중...');
  await pool.query(sql);
  console.log('✅ 테이블 생성 완료');

  // PostGIS 확인
  const ext = await pool.query(
    `SELECT extversion FROM pg_extension WHERE extname = 'postgis'`
  );
  if (ext.rows.length) {
    console.log('✅ PostGIS 버전:', ext.rows[0].extversion);
  } else {
    console.warn('⚠️  PostGIS가 활성화되지 않았습니다.');
  }

  // 테이블 목록 출력
  const tables = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  console.log('\n📋 생성된 테이블:');
  tables.rows.forEach(r => console.log('  -', r.tablename));

  await pool.end();
  console.log('\n🎉 마이그레이션 완료!');
}

migrate().catch(err => {
  console.error('\n❌ 마이그레이션 실패:', err.message);
  process.exit(1);
});
