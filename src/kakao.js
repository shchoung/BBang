/**
 * 빵친자 크롤러 스케줄러
 *
 * 실행 방식:
 *   1. 스케줄 모드 (기본): node src/crawler/scheduler.js
 *      → 매일 새벽 3시 자동 실행
 *
 *   2. 즉시 실행 모드:
 *      node src/crawler/scheduler.js --run-now
 *      → 지금 바로 크롤링 한 번 실행
 */

require('dotenv').config();
const cron = require('node-cron');
const { crawlAllAreas } = require('./kakao');
const { upsertBakeries, logCrawlRun } = require('../db/save');

const RUN_NOW = process.argv.includes('--run-now');

// ── 핵심: 크롤링 1회 실행 ──────────────────────────────
async function runCrawl() {
  const startedAt = new Date();
  console.log(`\n🍞 [${startedAt.toLocaleString('ko-KR')}] 빵친자 크롤링 시작`);
  console.log('─'.repeat(50));

  let total = 0, inserted = 0, updated = 0, skipped = 0;

  try {
    // 1. 카카오 API 전체 지역 수집
    console.log('\n📡 카카오 로컬 API 수집 중...');
    const bakeries = await crawlAllAreas();
    total = bakeries.length;
    console.log(`\n✅ 수집 완료: ${total}개`);

    // 2. DB UPSERT
    if (process.env.DATABASE_URL) {
      console.log('\n💾 DB 저장 중...');
      const stats = await upsertBakeries(bakeries);
      inserted = stats.inserted;
      updated  = stats.updated;
      skipped  = stats.skipped;
      console.log(`  신규: ${inserted}개 / 갱신: ${updated}개 / 중복 스킵: ${skipped}개`);

      // 3. 크롤링 이력 기록
      await logCrawlRun({ source: 'kakao', total, inserted, updated, skipped });
    } else {
      // DB 없을 때 — JSON 파일로 저장 (테스트용)
      const fs = require('fs');
      const outPath = `./crawl-result-${Date.now()}.json`;
      fs.writeFileSync(outPath, JSON.stringify(bakeries, null, 2));
      console.log(`\n⚠️  DATABASE_URL 없음 → ${outPath} 에 저장`);
    }

  } catch (err) {
    console.error('\n❌ 크롤링 실패:', err.message);
    await logCrawlRun({ source: 'kakao', total, inserted, updated, skipped, error: err.message })
      .catch(() => {});
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n⏱  소요 시간: ${elapsed}s`);
  console.log('─'.repeat(50));
}

// ── 즉시 실행 모드 ───────────────────────────────────
if (RUN_NOW) {
  runCrawl().then(() => process.exit(0));
}

// ── 스케줄 모드: 매일 새벽 3:00 KST ─────────────────
else {
  console.log('🕐 빵친자 크롤러 스케줄러 시작');
  console.log('   실행 주기: 매일 새벽 3:00 (KST)');
  console.log('   즉시 실행: node src/crawler/scheduler.js --run-now\n');

  // '0 18 * * *' = UTC 18:00 = KST 03:00
  cron.schedule('0 18 * * *', () => {
    runCrawl();
  }, {
    timezone: 'UTC',
  });

  // 스케줄러 프로세스 유지
  process.on('SIGTERM', () => {
    console.log('\n스케줄러 종료');
    process.exit(0);
  });
}

module.exports = { runCrawl };
