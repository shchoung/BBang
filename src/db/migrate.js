/**
 * 실행: node src/db/migrate.js
 *
 * SQL을 한 번에 넘기지 않고 구문 단위로 분리해서 순차 실행.
 * Railway PostgreSQL의 pg_stat_statements 충돌 방지.
 */
require('dotenv').config();
const { pool, checkConnection } = require('./pool');

// ── 마이그레이션 구문 목록 ───────────────────────────────────
const STEPS = [
  {
    label: 'PostGIS 확장',
    sql: `CREATE EXTENSION IF NOT EXISTS postgis`,
  },
  {
    label: 'uuid-ossp 확장',
    sql: `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
  },
  {
    label: 'bakeries 테이블',
    sql: `
      CREATE TABLE IF NOT EXISTS bakeries (
        id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        kakao_id             VARCHAR(20) UNIQUE,
        name                 VARCHAR(100) NOT NULL,
        address              TEXT,
        phone                VARCHAR(20),
        url                  TEXT,
        geom                 GEOMETRY(Point, 4326) NOT NULL,
        category             VARCHAR(100),
        source               VARCHAR(20) DEFAULT 'kakao',
        representative_bread VARCHAR(100),
        icon_url             TEXT,
        level                SMALLINT DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
        level_score          NUMERIC(5,2) DEFAULT 0,
        avg_rating           NUMERIC(3,2) DEFAULT 0,
        review_count         INTEGER DEFAULT 0,
        avg_daily_sales      INTEGER DEFAULT 0,
        crawled_at           TIMESTAMPTZ,
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `,
  },
  {
    label: 'bakeries 공간 인덱스',
    sql: `CREATE INDEX IF NOT EXISTS idx_bakeries_geom ON bakeries USING GIST (geom)`,
  },
  {
    label: 'bakeries level 인덱스',
    sql: `CREATE INDEX IF NOT EXISTS idx_bakeries_level ON bakeries (level)`,
  },
  {
    label: 'reviews 테이블',
    sql: `
      CREATE TABLE IF NOT EXISTS reviews (
        id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        bakery_id  UUID NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
        user_id    UUID,
        rating     SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        content    TEXT,
        bread_name VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `,
  },
  {
    label: 'reviews 인덱스',
    sql: `CREATE INDEX IF NOT EXISTS idx_reviews_bakery ON reviews (bakery_id)`,
  },
  {
    label: 'sales_reports 테이블',
    sql: `
      CREATE TABLE IF NOT EXISTS sales_reports (
        id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        bakery_id    UUID NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
        reported_at  DATE NOT NULL DEFAULT CURRENT_DATE,
        daily_sales  INTEGER NOT NULL CHECK (daily_sales >= 0),
        source       VARCHAR(20) DEFAULT 'owner',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `,
  },
  {
    label: 'sales_reports 인덱스',
    sql: `CREATE INDEX IF NOT EXISTS idx_sales_bakery ON sales_reports (bakery_id, reported_at)`,
  },
  {
    label: 'crawl_logs 테이블',
    sql: `
      CREATE TABLE IF NOT EXISTS crawl_logs (
        id       SERIAL PRIMARY KEY,
        source   VARCHAR(20),
        total    INTEGER DEFAULT 0,
        inserted INTEGER DEFAULT 0,
        updated  INTEGER DEFAULT 0,
        skipped  INTEGER DEFAULT 0,
        error    TEXT,
        ran_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `,
  },
  {
    label: '레벨 계산 함수',
    sql: `
      CREATE OR REPLACE FUNCTION calc_bakery_level(
        p_avg_rating   NUMERIC,
        p_review_count INTEGER,
        p_avg_sales    INTEGER
      ) RETURNS TABLE (level SMALLINT, score NUMERIC) AS $$
      DECLARE
        rating_score NUMERIC;
        review_score NUMERIC;
        sales_score  NUMERIC;
        total_score  NUMERIC;
      BEGIN
        rating_score := COALESCE(p_avg_rating, 0) / 5.0 * 40;
        review_score := CASE
          WHEN p_review_count >= 50 THEN 30
          WHEN p_review_count >= 20 THEN 22.5
          WHEN p_review_count >= 5  THEN 15
          ELSE 0
        END;
        sales_score := CASE
          WHEN p_avg_sales >= 200 THEN 30
          WHEN p_avg_sales >= 100 THEN 22.5
          WHEN p_avg_sales >= 30  THEN 15
          ELSE 0
        END;
        total_score := rating_score + review_score + sales_score;
        RETURN QUERY SELECT
          CASE
            WHEN total_score >= 90 THEN 5::SMALLINT
            WHEN total_score >= 75 THEN 4::SMALLINT
            WHEN total_score >= 60 THEN 3::SMALLINT
            WHEN total_score >= 40 THEN 2::SMALLINT
            ELSE 1::SMALLINT
          END,
          ROUND(total_score, 2);
      END;
      $$ LANGUAGE plpgsql
    `,
  },
  {
    label: '레벨 자동갱신 트리거 함수',
    sql: `
      CREATE OR REPLACE FUNCTION refresh_bakery_level() RETURNS TRIGGER AS $$
      DECLARE
        stats RECORD;
        lvl   RECORD;
      BEGIN
        SELECT
          AVG(r.rating)::NUMERIC(3,2) AS avg_rating,
          COUNT(r.id)::INTEGER        AS review_count,
          COALESCE((
            SELECT AVG(daily_sales)::INTEGER
            FROM sales_reports
            WHERE bakery_id = NEW.bakery_id
              AND reported_at >= CURRENT_DATE - INTERVAL '30 days'
          ), 0) AS avg_sales
        INTO stats
        FROM reviews r
        WHERE r.bakery_id = NEW.bakery_id;

        SELECT * INTO lvl
        FROM calc_bakery_level(stats.avg_rating, stats.review_count, stats.avg_sales);

        UPDATE bakeries SET
          avg_rating      = stats.avg_rating,
          review_count    = stats.review_count,
          avg_daily_sales = stats.avg_sales,
          level           = lvl.level,
          level_score     = lvl.score,
          updated_at      = NOW()
        WHERE id = NEW.bakery_id;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `,
  },
  {
    label: '레벨 트리거 등록',
    sql: `
      CREATE OR REPLACE TRIGGER trg_review_level
        AFTER INSERT OR UPDATE ON reviews
        FOR EACH ROW EXECUTE FUNCTION refresh_bakery_level()
    `,
  },
];

// ── 실행 ─────────────────────────────────────────────────────
async function migrate() {
  console.log('🔌 DB 연결 확인 중...');
  const info = await checkConnection();
  console.log('✅ 연결 성공');
  console.log('   PostgreSQL:', info.version.split(' ').slice(0, 2).join(' '), '\n');

  for (const step of STEPS) {
    try {
      await pool.query(step.sql.trim());
      console.log(`✅ ${step.label}`);
    } catch (err) {
      // 이미 존재하는 경우 등 무해한 에러는 경고만
      if (err.message.includes('already exists')) {
        console.log(`⏭  ${step.label} (이미 존재)`);
      } else {
        console.error(`❌ ${step.label} 실패: ${err.message}`);
        throw err;
      }
    }
  }

  // 결과 확인
  const tables = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  console.log('\n📋 생성된 테이블:');
  tables.rows.forEach(r => console.log('  -', r.tablename));

  const extRes = await pool.query(`SELECT extname, extversion FROM pg_extension WHERE extname IN ('postgis','uuid-ossp')`);
  console.log('\n🔌 활성 익스텐션:');
  extRes.rows.forEach(r => console.log(`  - ${r.extname} ${r.extversion}`));

  await pool.end();
  console.log('\n🎉 마이그레이션 완료!');
}

migrate().catch(err => {
  console.error('\n❌ 마이그레이션 실패:', err.message);
  process.exit(1);
});
