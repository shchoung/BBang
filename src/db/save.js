/**
 * 크롤링 결과를 PostGIS DB에 저장
 * - kakao_id 기준 UPSERT (중복 방지)
 * - ST_Distance로 30m 내 중복 빵집 감지
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

/**
 * bakeries 테이블에 UPSERT
 * - kakao_id가 같으면 주소·전화번호 업데이트
 * - 없으면 INSERT (초기 레벨 1)
 */
async function upsertBakeries(bakeries) {
  const client = await pool.connect();
  let inserted = 0, updated = 0, skipped = 0;

  try {
    await client.query('BEGIN');

    for (const b of bakeries) {
      // 30m 반경 내 기존 데이터 확인 (공간 중복 체크)
      const dupCheck = await client.query(
        `SELECT id FROM bakeries
         WHERE ST_DWithin(
           geom,
           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
           30
         )
         AND kakao_id IS DISTINCT FROM $3
         LIMIT 1`,
        [b.lng, b.lat, b.kakao_id]
      );

      if (dupCheck.rows.length > 0) {
        skipped++;
        continue; // 30m 내 다른 출처 빵집 있으면 건너뜀
      }

      const res = await client.query(
        `INSERT INTO bakeries
           (kakao_id, name, address, phone, url, geom, category, source, crawled_at, level, level_score)
         VALUES
           ($1, $2, $3, $4, $5,
            ST_SetSRID(ST_MakePoint($6, $7), 4326),
            $8, $9, $10, 1, 0)
         ON CONFLICT (kakao_id)
         DO UPDATE SET
           name       = EXCLUDED.name,
           address    = EXCLUDED.address,
           phone      = EXCLUDED.phone,
           crawled_at = EXCLUDED.crawled_at
         RETURNING (xmax = 0) AS is_insert`,
        [b.kakao_id, b.name, b.address, b.phone, b.url,
         b.lng, b.lat, b.category, b.source, b.crawled_at]
      );

      res.rows[0].is_insert ? inserted++ : updated++;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, updated, skipped };
}

/**
 * 크롤링 이력 기록
 */
async function logCrawlRun({ source, total, inserted, updated, skipped, error }) {
  await pool.query(
    `INSERT INTO crawl_logs (source, total, inserted, updated, skipped, error, ran_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [source, total, inserted, updated, skipped, error || null]
  ).catch(err => console.error('로그 기록 실패:', err.message));
}

module.exports = { upsertBakeries, logCrawlRun, pool };
