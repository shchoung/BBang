-- ============================================================
-- 빵친자 DB 초기 스키마
-- PostGIS 확장 필요: CREATE EXTENSION postgis;
-- ============================================================

-- PostGIS 확장 활성화
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── 빵집 테이블 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bakeries (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kakao_id            VARCHAR(20) UNIQUE,          -- 카카오 장소 ID (중복 방지 키)
  name                VARCHAR(100) NOT NULL,
  address             TEXT,
  phone               VARCHAR(20),
  url                 TEXT,
  geom                GEOMETRY(Point, 4326) NOT NULL, -- 경위도 (WGS84)
  category            VARCHAR(100),
  source              VARCHAR(20) DEFAULT 'kakao',  -- kakao | naver | user
  representative_bread VARCHAR(100),
  icon_url            TEXT,

  -- 레벨 시스템
  level               SMALLINT DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
  level_score         NUMERIC(5,2) DEFAULT 0,

  -- 통계 캐시 (레벨 계산용)
  avg_rating          NUMERIC(3,2) DEFAULT 0,
  review_count        INTEGER DEFAULT 0,
  avg_daily_sales     INTEGER DEFAULT 0,

  crawled_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- 공간 인덱스 (ST_DWithin, ST_Within 쿼리 최적화)
CREATE INDEX IF NOT EXISTS idx_bakeries_geom
  ON bakeries USING GIST (geom);

-- 레벨 인덱스 (필터 쿼리용)
CREATE INDEX IF NOT EXISTS idx_bakeries_level
  ON bakeries (level);

-- ── 후기 테이블 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bakery_id   UUID NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  user_id     UUID,                        -- 추후 users 테이블 연동
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  content     TEXT,
  bread_name  VARCHAR(100),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_bakery ON reviews (bakery_id);

-- ── 판매량 테이블 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_reports (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bakery_id    UUID NOT NULL REFERENCES bakeries(id) ON DELETE CASCADE,
  reported_at  DATE NOT NULL DEFAULT CURRENT_DATE,
  daily_sales  INTEGER NOT NULL CHECK (daily_sales >= 0),
  source       VARCHAR(20) DEFAULT 'owner',  -- owner | crawler
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_bakery ON sales_reports (bakery_id, reported_at);

-- ── 크롤링 이력 테이블 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS crawl_logs (
  id       SERIAL PRIMARY KEY,
  source   VARCHAR(20),   -- kakao | naver
  total    INTEGER DEFAULT 0,
  inserted INTEGER DEFAULT 0,
  updated  INTEGER DEFAULT 0,
  skipped  INTEGER DEFAULT 0,
  error    TEXT,
  ran_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── 레벨 자동 계산 함수 + 트리거 ───────────────────────────
CREATE OR REPLACE FUNCTION calc_bakery_level(
  p_avg_rating    NUMERIC,
  p_review_count  INTEGER,
  p_avg_sales     INTEGER
) RETURNS TABLE (level SMALLINT, score NUMERIC) AS $$
DECLARE
  rating_score  NUMERIC;
  review_score  NUMERIC;
  sales_score   NUMERIC;
  total_score   NUMERIC;
BEGIN
  -- 별점 40점 (0~5점 → 0~40점)
  rating_score := COALESCE(p_avg_rating, 0) / 5.0 * 40;

  -- 후기 수 30점 (구간 환산)
  review_score := CASE
    WHEN p_review_count >= 50 THEN 30
    WHEN p_review_count >= 20 THEN 22.5
    WHEN p_review_count >= 5  THEN 15
    ELSE                           0
  END;

  -- 일평균 판매량 30점 (구간 환산)
  sales_score := CASE
    WHEN p_avg_sales >= 200 THEN 30
    WHEN p_avg_sales >= 100 THEN 22.5
    WHEN p_avg_sales >= 30  THEN 15
    ELSE                         0
  END;

  total_score := rating_score + review_score + sales_score;

  RETURN QUERY SELECT
    CASE
      WHEN total_score >= 90 THEN 5::SMALLINT
      WHEN total_score >= 75 THEN 4::SMALLINT
      WHEN total_score >= 60 THEN 3::SMALLINT
      WHEN total_score >= 40 THEN 2::SMALLINT
      ELSE                       1::SMALLINT
    END,
    ROUND(total_score, 2);
END;
$$ LANGUAGE plpgsql;

-- 후기 INSERT 시 bakery 통계 자동 갱신
CREATE OR REPLACE FUNCTION refresh_bakery_level() RETURNS TRIGGER AS $$
DECLARE
  stats RECORD;
  lvl   RECORD;
BEGIN
  -- 통계 재집계
  SELECT
    AVG(r.rating)::NUMERIC(3,2)   AS avg_rating,
    COUNT(r.id)::INTEGER          AS review_count,
    COALESCE((
      SELECT AVG(daily_sales)::INTEGER
      FROM sales_reports
      WHERE bakery_id = NEW.bakery_id
        AND reported_at >= CURRENT_DATE - INTERVAL '30 days'
    ), 0)                         AS avg_sales
  INTO stats
  FROM reviews r
  WHERE r.bakery_id = NEW.bakery_id;

  -- 레벨 계산
  SELECT * INTO lvl
  FROM calc_bakery_level(stats.avg_rating, stats.review_count, stats.avg_sales);

  -- bakeries 업데이트
  UPDATE bakeries SET
    avg_rating    = stats.avg_rating,
    review_count  = stats.review_count,
    avg_daily_sales = stats.avg_sales,
    level         = lvl.level,
    level_score   = lvl.score,
    updated_at    = NOW()
  WHERE id = NEW.bakery_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_review_level
  AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION refresh_bakery_level();
