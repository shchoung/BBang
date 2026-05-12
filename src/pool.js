/**
 * 카카오 로컬 API 크롤러
 * - 공식 API: https://developers.kakao.com/docs/latest/ko/local/dev-guide
 * - 카테고리 코드 FD6 = 음식점, 키워드 "베이커리/빵집"
 * - 페이지당 최대 15개 × 최대 45페이지 = 최대 675개/요청
 */

const KAKAO_API_KEY = process.env.KAKAO_REST_API_KEY;
const BASE_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';

// 서울 주요 지역 중심 좌표 (격자 탐색용)
const SEARCH_AREAS = [
  { name: '강남',   x: 127.0495,  y: 37.5172 },
  { name: '홍대',   x: 126.9228,  y: 37.5572 },
  { name: '이태원', x: 126.9944,  y: 37.5347 },
  { name: '성수',   x: 127.0561,  y: 37.5445 },
  { name: '연남',   x: 126.9207,  y: 37.5621 },
  { name: '마포',   x: 126.9009,  y: 37.5542 },
  { name: '종로',   x: 126.9910,  y: 37.5728 },
  { name: '건대',   x: 127.0700,  y: 37.5404 },
  { name: '신촌',   x: 126.9368,  y: 37.5596 },
  { name: '잠실',   x: 127.1001,  y: 37.5132 },
  { name: '노원',   x: 127.0700,  y: 37.6541 },
  { name: '신림',   x: 126.9298,  y: 37.4843 },
];

/**
 * 단일 페이지 요청
 */
async function fetchPage(area, page = 1) {
  const params = new URLSearchParams({
    query:    '빵집',
    category_group_code: 'FD6',   // 음식점 카테고리
    x:        area.x,
    y:        area.y,
    radius:   2000,                // 반경 2km
    page,
    size:     15,
    sort:     'accuracy',
  });

  const res = await fetch(`${BASE_URL}?${params}`, {
    headers: { Authorization: `KakaoAK ${KAKAO_API_KEY}` },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`카카오 API 오류 [${res.status}]: ${err}`);
  }

  return res.json();
}

/**
 * 한 지역의 모든 페이지 수집
 */
async function crawlArea(area) {
  const results = [];
  let page = 1;

  console.log(`  📍 [${area.name}] 수집 시작`);

  while (true) {
    const data = await fetchPage(area, page);
    const { documents, meta } = data;

    // 베이커리 관련 키워드 필터링 (카테고리 정밀화)
    const bakeries = documents.filter(doc =>
      doc.category_name.includes('베이커리') ||
      doc.category_name.includes('빵') ||
      doc.place_name.includes('베이커리') ||
      doc.place_name.includes('브레드') ||
      doc.place_name.includes('빵집')
    );

    results.push(...bakeries);
    console.log(`    페이지 ${page}/${Math.ceil(meta.pageable_count / 15)} — ${bakeries.length}개 수집 (누적: ${results.length}개)`);

    // 마지막 페이지 또는 45페이지 제한
    if (meta.is_end || page >= 45) break;
    page++;

    // Rate limit 방지: 요청 간 300ms 대기
    await sleep(300);
  }

  return results;
}

/**
 * 카카오 문서 → DB 형식 변환
 */
function normalize(doc, areaName) {
  return {
    kakao_id:    doc.id,
    name:        doc.place_name,
    address:     doc.road_address_name || doc.address_name,
    phone:       doc.phone || null,
    url:         doc.place_url || null,
    lat:         parseFloat(doc.y),
    lng:         parseFloat(doc.x),
    category:    doc.category_name,
    source:      'kakao',
    source_area: areaName,
    crawled_at:  new Date().toISOString(),
  };
}

/**
 * 전체 지역 순차 크롤링 (메인 export)
 */
async function crawlAllAreas(areas = SEARCH_AREAS) {
  if (!KAKAO_API_KEY) {
    throw new Error('KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  const allResults = [];
  const seen = new Set(); // kakao_id 중복 제거

  for (const area of areas) {
    try {
      const docs = await crawlArea(area);
      for (const doc of docs) {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          allResults.push(normalize(doc, area.name));
        }
      }
      // 지역 간 1초 대기 (API 부하 방지)
      await sleep(1000);
    } catch (err) {
      console.error(`  ❌ [${area.name}] 크롤링 실패:`, err.message);
    }
  }

  return allResults;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { crawlAllAreas, crawlArea, SEARCH_AREAS };
