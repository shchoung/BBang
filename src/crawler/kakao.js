/**
 * 떡친자 — 전국 카카오 로컬 API 크롤러
 *
 * 전략: 한국 전역을 격자(grid)로 분할 → 각 격자 중심점에서 반경 10km 검색
 *   - 경도 125.0~129.6 / 위도 33.0~38.7 (제주 포함)
 *   - 격자 간격 0.13° (lng) × 0.09° (lat) ≈ 10km
 *   - 도심/읍내 격자 자동 조밀화: 인구밀집 지역은 5km 반경 추가
 *
 * 카카오 API 제한:
 *   - 페이지당 최대 15개, 최대 45페이지 → 격자당 최대 675개
 *   - 일일 300,000 요청 (전국 1회 ≈ 6,000~15,000 요청)
 */

const KAKAO_API_KEY = process.env.KAKAO_REST_API_KEY;
const BASE_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json';

// ── 전국 주요 도시 중심 (고떡보의하루 보완 탐색용) ─────────────────
const DENSE_CITIES = [
  // 특별·광역시
  { name:'서울',     x:126.9780, y:37.5665, r:15000 },
  { name:'부산',     x:129.0756, y:35.1796, r:12000 },
  { name:'인천',     x:126.7052, y:37.4563, r:10000 },
  { name:'대구',     x:128.6014, y:35.8714, r:10000 },
  { name:'광주',     x:126.8514, y:35.1595, r:8000  },
  { name:'대전',     x:127.3845, y:36.3504, r:8000  },
  { name:'울산',     x:129.3114, y:35.5384, r:8000  },
  { name:'세종',     x:127.2890, y:36.4800, r:5000  },
  // 경기
  { name:'수원',     x:127.0286, y:37.2636, r:7000  },
  { name:'성남',     x:127.1378, y:37.4449, r:6000  },
  { name:'고양',     x:126.8320, y:37.6584, r:6000  },
  { name:'용인',     x:127.1776, y:37.2410, r:6000  },
  { name:'부천',     x:126.7830, y:37.5034, r:5000  },
  { name:'안산',     x:126.8220, y:37.3219, r:5000  },
  { name:'안양',     x:126.9568, y:37.3943, r:5000  },
  { name:'남양주',   x:127.2165, y:37.6360, r:5000  },
  { name:'화성',     x:126.8317, y:37.1994, r:5000  },
  { name:'평택',     x:127.1122, y:36.9921, r:5000  },
  // 충청
  { name:'청주',     x:127.4890, y:36.6424, r:7000  },
  { name:'천안',     x:127.1533, y:36.8151, r:6000  },
  // 전라
  { name:'전주',     x:127.1480, y:35.8242, r:7000  },
  { name:'목포',     x:126.3869, y:34.8118, r:5000  },
  { name:'여수',     x:127.6622, y:34.7604, r:5000  },
  // 경상
  { name:'창원',     x:128.6811, y:35.2278, r:7000  },
  { name:'포항',     x:129.3435, y:36.0190, r:6000  },
  { name:'경주',     x:129.2114, y:35.8562, r:5000  },
  { name:'구미',     x:128.3445, y:36.1196, r:5000  },
  { name:'진주',     x:128.1072, y:35.1796, r:5000  },
  // 강원
  { name:'춘천',     x:127.7296, y:37.8813, r:6000  },
  { name:'원주',     x:127.9201, y:37.3422, r:5000  },
  { name:'강릉',     x:128.8761, y:37.7519, r:5000  },
  // 제주
  { name:'제주시',   x:126.5312, y:33.4996, r:7000  },
  { name:'서귀포',   x:126.5628, y:33.2541, r:5000  },
];

// ── 전국 격자 생성 ───────────────────────────────────────────
function buildGrid() {
  const grid = [];

  // 한반도 본토 + 제주 영역
  const REGIONS = [
    { name:'본토', lngMin:125.8, lngMax:129.6, latMin:34.5, latMax:38.7 },
    { name:'제주', lngMin:126.1, lngMax:126.9, latMin:33.1, latMax:33.6 },
  ];

  const LNG_STEP = 0.13; // ≈ 11.4km
  const LAT_STEP = 0.09; // ≈ 10km

  for (const region of REGIONS) {
    for (let lng = region.lngMin; lng <= region.lngMax; lng = +(lng + LNG_STEP).toFixed(4)) {
      for (let lat = region.latMin; lat <= region.latMax; lat = +(lat + LAT_STEP).toFixed(4)) {
        grid.push({
          name: `${region.name}_${lng.toFixed(2)}_${lat.toFixed(2)}`,
          x: +lng.toFixed(4),
          y: +lat.toFixed(4),
          radius: 10000,
        });
      }
    }
  }

  return grid;
}

// ── API 단일 페이지 요청 ─────────────────────────────────────
async function fetchPage(area, page = 1) {
  const params = new URLSearchParams({
    query:               '떡집',
    category_group_code: 'FD6',
    x:                   area.x,
    y:                   area.y,
    radius:              area.radius || 10000,
    page,
    size:                15,
    sort:                'accuracy',
  });

  const res = await fetch(`${BASE_URL}?${params}`, {
    headers: { Authorization: `KakaoAK ${KAKAO_API_KEY}` },
  });

  if (res.status === 429) {
    // Rate limit — 5초 대기 후 재시도
    console.warn('    ⏳ Rate limit 도달, 5초 대기...');
    await sleep(5000);
    return fetchPage(area, page);
  }

  if (!res.ok) throw new Error(`카카오 API 오류 [${res.status}]: ${await res.text()}`);
  return res.json();
}

// ── 단일 격자 전체 페이지 수집 ──────────────────────────────
async function crawlGrid(area) {
  const results = [];
  let page = 1;

  while (true) {
    const { documents, meta } = await fetchPage(area, page);

    // 떡집 필터
    const filtered = documents.filter(doc =>
      doc.category_name.includes('떡') ||
      doc.category_name.includes('방앗간') ||
      doc.place_name.match(/떡집|떡방|방앗간|한과|찹쌀|인절미/i)
    );
    results.push(...filtered);

    if (meta.is_end || page >= 45) break;

    // 한 격자에서 결과가 많으면 (≥600개) 경고 — 격자를 더 쪼개야 할 수 있음
    if (page === 40) {
      console.warn(`    ⚠️  [${area.name}] 결과 과다 — 격자 분할 권장`);
    }

    page++;
    await sleep(200); // 페이지 간 200ms
  }

  return results;
}

// ── 카카오 응답 정규화 ───────────────────────────────────────
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

// ── 전국 크롤링 메인 ─────────────────────────────────────────
async function crawlNationwide({ onProgress } = {}) {
  if (!KAKAO_API_KEY) throw new Error('KAKAO_REST_API_KEY 환경변수가 없습니다.');

  // 격자 + 도심 고떡보의하루 탐색 합산
  const gridAreas  = buildGrid();
  const allAreas   = [...gridAreas, ...DENSE_CITIES];

  console.log(`\n🗺  전국 크롤링 시작`);
  console.log(`   격자: ${gridAreas.length}개 + 주요도시: ${DENSE_CITIES.length}개 = 총 ${allAreas.length}개 탐색 지점`);
  console.log(`   예상 소요: 약 ${Math.round(allAreas.length * 3 * 200 / 1000 / 60)}~${Math.round(allAreas.length * 10 * 200 / 1000 / 60)}분\n`);

  const seen    = new Set();
  const results = [];
  let   done    = 0;

  for (const area of allAreas) {
    try {
      const docs = await crawlGrid(area);
      let newCount = 0;

      for (const doc of docs) {
        if (!seen.has(doc.id)) {
          seen.add(doc.id);
          results.push(normalize(doc, area.name));
          newCount++;
        }
      }

      done++;
      const pct = ((done / allAreas.length) * 100).toFixed(1);

      if (done % 50 === 0 || newCount > 0) {
        process.stdout.write(`\r  [${pct}%] ${done}/${allAreas.length} 탐색 — 누적 ${results.length}개 수집`);
      }

      if (onProgress) onProgress({ done, total: allAreas.length, collected: results.length });

    } catch (err) {
      console.error(`\n  ❌ [${area.name}] 실패: ${err.message}`);
    }

    // 격자 간 딜레이: 도심은 500ms, 일반 격자는 300ms
    await sleep(area.radius > 8000 ? 500 : 300);
  }

  console.log(`\n\n✅ 전국 수집 완료: 총 ${results.length}개 (중복 제거 후)`);
  return results;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { crawlNationwide, buildGrid, DENSE_CITIES };
