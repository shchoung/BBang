/**
 * 떡친자 크롤러 스케줄러 — 전국 버전
 *
 * 실행 방식:
 *   스케줄 모드: node src/crawler/scheduler.js
 *     → 매주 월·목 새벽 2시 전국 크롤링
 *     → 매일 새벽 4시 주요 도시만 빠른 갱신
 *
 *   즉시 실행:
 *     node src/crawler/scheduler.js --run-now            전국
 *     node src/crawler/scheduler.js --run-now --cities   도시만
 */

require('dotenv').config();
const cron = require('node-cron');
const { crawlNationwide, DENSE_CITIES } = require('./kakao');
const { upsertBakeries, logCrawlRun }   = require('../db/save');
const fs = require('fs');

const RUN_NOW      = process.argv.includes('--run-now');
const CITIES_ONLY  = process.argv.includes('--cities');

// ── 크롤링 1회 실행 ──────────────────────────────────────────
async function runCrawl(options = {}) {
  const { citiesOnly = false } = options;
  const startedAt = new Date();
  const label = citiesOnly ? '주요도시 빠른갱신' : '전국 크롤링';

  console.log(`\n🍡 [${startedAt.toLocaleString('ko-KR')}] ${label} 시작`);
  console.log('─'.repeat(60));

  let total = 0, inserted = 0, updated = 0, skipped = 0, errorMsg = null;

  try {
    // 1. 수집
    let bakeries;
    if (citiesOnly) {
      // 주요 도시만 빠르게 (약 5분)
      const { crawlNationwide: crawl } = require('./kakao');
      const { crawlNationwide: _unused, ...rest } = require('./kakao');
      // DENSE_CITIES만 따로 crawlNationwide에 areas 옵션으로 넘기기
      bakeries = await crawlNationwide({ areas: DENSE_CITIES });
    } else {
      bakeries = await crawlNationwide();
    }

    total = bakeries.length;

    // 2. DB 저장
    if (process.env.DATABASE_URL) {
      console.log('\n💾 DB 저장 중...');
      const stats = await upsertBakeries(bakeries);
      inserted = stats.inserted;
      updated  = stats.updated;
      skipped  = stats.skipped;
      console.log(`  신규: ${inserted}개 / 갱신: ${updated}개 / 중복 스킵: ${skipped}개`);
    } else {
      // DB 없으면 JSON fallback
      const outPath = `./crawl-${citiesOnly ? 'cities' : 'nationwide'}-${Date.now()}.json`;
      fs.writeFileSync(outPath, JSON.stringify(bakeries, null, 2));
      console.log(`\n⚠️  DATABASE_URL 없음 → ${outPath} 저장`);
    }

  } catch (err) {
    errorMsg = err.message;
    console.error('\n❌ 크롤링 실패:', err.message);
  }

  // 3. 이력 기록
  await logCrawlRun({
    source: citiesOnly ? 'kakao-cities' : 'kakao-nationwide',
    total, inserted, updated, skipped,
    error: errorMsg,
  }).catch(() => {});

  const elapsed = ((Date.now() - startedAt) / 1000 / 60).toFixed(1);
  console.log(`\n⏱  소요 시간: ${elapsed}분`);
  console.log('─'.repeat(60));
}

// ── 즉시 실행 ────────────────────────────────────────────────
if (RUN_NOW) {
  runCrawl({ citiesOnly: CITIES_ONLY }).then(() => process.exit(0));
}

// ── 스케줄 모드 ──────────────────────────────────────────────
else {
  console.log('🕐 떡친자 크롤러 스케줄러 (전국 모드)');
  console.log('   전국 크롤링:   매주 월·목 새벽 2:00 KST');
  console.log('   도시 빠른갱신: 매일 새벽 4:00 KST');
  console.log('\n   수동 실행:');
  console.log('     전국:   node src/crawler/scheduler.js --run-now');
  console.log('     도시만: node src/crawler/scheduler.js --run-now --cities\n');

  // 전국: 월·목 UTC 17:00 = KST 02:00
  cron.schedule('0 17 * * 1,4', () => {
    console.log('📅 전국 크롤링 스케줄 발동');
    runCrawl({ citiesOnly: false });
  }, { timezone: 'UTC' });

  // 주요 도시 빠른갱신: 매일 UTC 19:00 = KST 04:00
  cron.schedule('0 19 * * *', () => {
    console.log('📅 도시 빠른갱신 스케줄 발동');
    runCrawl({ citiesOnly: true });
  }, { timezone: 'UTC' });

  process.on('SIGTERM', () => { console.log('\n스케줄러 종료'); process.exit(0); });
}

module.exports = { runCrawl };
