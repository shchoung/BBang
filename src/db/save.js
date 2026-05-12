/**
 * 크롤링 결과 DB 저장 — PostGIS 없는 버전
 * 중복 제거: kakao_id UNIQUE + Haversine 30m 체크
 */
const { pool } = require('./pool');

// 두 좌표 간 거리(m) 계산
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function upsertBakeries(bakeries) {
  const client = await pool.connect();
  let inserted = 0, updated = 0, skipped = 0;

  try {
    await client.query('BEGIN');

    // 기존 좌표 전부 캐시 (30m 중복 체크용, PostGIS 없이 메모리에서 처리)
    const { rows: existing } = await client.query(`SELECT kakao_id, lat, lng FROM bakeries`);
    const existingCoords = existing.map(r => ({
      kakao_id: r.kakao_id,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lng),
    }));

    for (const b of bakeries) {
      // 30m 내 다른 빵집 있으면 스킵 (kakao_id 다른 것만 체크)
      const isDup = existingCoords.some(e =>
        e.kakao_id !== b.kakao_id &&
        distanceM(b.lat, b.lng, e.lat, e.lng) < 30
      );
      if (isDup) { skipped++; continue; }

      const res = await client.query(
        `INSERT INTO bakeries (kakao_id, name, address, phone, url, lat, lng, category, source, crawled_at, level, level_score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, 1, 0)
         ON CONFLICT (kakao_id) DO UPDATE SET
           name=EXCLUDED.name, address=EXCLUDED.address,
           phone=EXCLUDED.phone, crawled_at=EXCLUDED.crawled_at
         RETURNING (xmax = 0) AS is_insert`,
        [b.kakao_id, b.name, b.address, b.phone, b.url,
         b.lat, b.lng, b.category, b.source, b.crawled_at]
      );

      if (res.rows[0].is_insert) {
        inserted++;
        existingCoords.push({ kakao_id: b.kakao_id, lat: b.lat, lng: b.lng });
      } else {
        updated++;
      }
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

async function logCrawlRun({ source, total, inserted, updated, skipped, error }) {
  await pool.query(
    `INSERT INTO crawl_logs (source, total, inserted, updated, skipped, error, ran_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
    [source, total, inserted, updated, skipped, error || null]
  ).catch(err => console.error('로그 기록 실패:', err.message));
}

module.exports = { upsertBakeries, logCrawlRun, pool };
