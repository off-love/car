'use strict';

// ============================================================
// API 키 (고정)
// ============================================================
const KAKAO_JS_KEY = 'd3c12a67fbaad73696ba91c3ffa8a612';
const KAKAO_REST_KEY = '7731611486d52ad5df97834bed2971cf';

// ============================================================
// STATE
// ============================================================
const S = {
  settings: {
    jsKey: KAKAO_JS_KEY, restKey: KAKAO_REST_KEY,
    officeAddr: '', officeX: '', officeY: '',
    fixOffice: true, driver: '', vehicle: '',
    defaultRegion: '' // 기본 지역 필터
  },
  waypoints: [], // [{id,address,x,y,region}]
  segments: [],  // [{from,to,fromAddr,toAddr,distance}]
  totalDist: 0,
  mapInst: null,
  markers: [],
  polylines: [],
  favorites: [],
  history: [],
  pendingWpIdx: null,    // 주소 검색 대상 waypoint index
  pendingPostcodeData: null, // 중복 주소 확인 대기 데이터
  historyOpen: false,
  kakaoLoaded: false
};

const REGIONS = [
  ['전국', ''], ['서울', '서울'], ['경기', '경기'], ['인천', '인천'],
  ['부산', '부산'], ['대구', '대구'], ['대전', '대전'], ['광주', '광주'],
  ['울산', '울산'], ['세종', '세종'], ['강원', '강원'], ['충북', '충청북도'],
  ['충남', '충청남도'], ['전북', '전라북도'], ['전남', '전라남도'],
  ['경북', '경상북도'], ['경남', '경상남도'], ['제주', '제주']
];

// ============================================================
// STORAGE
// ============================================================
const load = k => { try { return JSON.parse(localStorage.getItem(k)) || null; } catch { return null; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

function loadAll() {
  const saved = load('drvlog_settings');
  if (saved) {
    S.settings = { ...S.settings, ...saved };
  }
  // API 키는 코드에 고정 — 저장값 무시
  S.settings.jsKey = KAKAO_JS_KEY;
  S.settings.restKey = KAKAO_REST_KEY;
  S.history = load('drvlog_history') || [];
}

// ============================================================
// TOAST
// ============================================================
let toastTimer;
function toast(msg, dur = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), dur);
}

// ============================================================
// MODAL
// ============================================================
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});
document.querySelectorAll('.modal-backdrop').forEach(el => {
  el.addEventListener('click', e => { if (e.target === el) closeModal(el.id); });
});

// ============================================================
// KAKAO SDK DYNAMIC LOAD
// ============================================================
function loadKakaoSDK(jsKey) {
  return new Promise((res, rej) => {
    // 이미 같은 키로 로드 완료된 경우 재사용
    if (S.kakaoLoaded && window.kakao?.maps && S.loadedJsKey === jsKey) { res(); return; }
    // 기존 kakao 스크립트 태그 제거
    document.querySelectorAll('script[src*="dapi.kakao.com/v2/maps"]').forEach(el => el.remove());
    S.kakaoLoaded = false;
    S.loadedJsKey = '';
    // 10초 타임아웃 — 콜백이 호출되지 않는 경우 대비
    const timer = setTimeout(() =>
      rej(new Error('로드 시간 초과 — 도메인(http://localhost:8787) 등록 여부와 JS API 키를 확인하세요')), 10000);
    const s = document.createElement('script');
    s.src = `//dapi.kakao.com/v2/maps/sdk.js?appkey=${jsKey}&libraries=services&autoload=false`;
    s.onload = () => {
      try {
        kakao.maps.load(() => {
          clearTimeout(timer);
          S.kakaoLoaded = true;
          S.loadedJsKey = jsKey;
          res();
        });
      } catch (e) { clearTimeout(timer); rej(new Error('SDK 초기화 오류: ' + e.message)); }
    };
    s.onerror = () => { clearTimeout(timer); rej(new Error('Kakao SDK 로드 실패 — JS API 키와 등록 도메인을 확인하세요')); };
    document.head.appendChild(s);
  });
}

function loadDaumPostcode() {
  return new Promise(res => {
    if (window.daum?.Postcode) { res(); return; }
    const s = document.createElement('script');
    s.src = 'https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js';
    s.onload = res;
    document.head.appendChild(s);
  });
}

// ============================================================
// MAP
// ============================================================
function initMap() {
  if (!window.kakao?.maps) return;
  const container = document.getElementById('map-container');
  container.innerHTML = ''; // 기존 지도 초기화
  const opts = { center: new kakao.maps.LatLng(37.5665, 126.9780), level: 7 };
  S.mapInst = new kakao.maps.Map(container, opts);
  S.markers = []; S.polylines = [];
  document.getElementById('map-placeholder').style.display = 'none';
}

function clearMapOverlays() {
  S.markers.forEach(m => m.setMap(null));
  S.polylines.forEach(p => p.setMap(null));
  S.markers = []; S.polylines = [];
}

function renderMapRoute(points, routeCoords) {
  if (!S.mapInst) return;
  clearMapOverlays();

  const bounds = new kakao.maps.LatLngBounds();

  // Draw polyline from route coords (or fallback straight lines)
  const path = (routeCoords && routeCoords.length > 0)
    ? routeCoords.map(([x, y]) => new kakao.maps.LatLng(y, x))
    : points.map(p => new kakao.maps.LatLng(p.y, p.x));

  const poly = new kakao.maps.Polyline({
    path, strokeWeight: 4, strokeColor: '#3B4AE8', strokeOpacity: .85, strokeStyle: 'solid'
  });
  poly.setMap(S.mapInst);
  S.polylines.push(poly);

  // Markers
  points.forEach((p, i) => {
    const pos = new kakao.maps.LatLng(p.y, p.x);
    bounds.extend(pos);
    const isFirst = i === 0, isLast = i === points.length - 1;
    const color = isFirst ? '#10b981' : isLast ? '#ef4444' : '#3B4AE8';
    const label = isFirst ? 'S' : isLast ? 'E' : String(i);

    const content = `<div style="background:${color};color:#fff;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25)">${label}</div>`;
    const overlay = new kakao.maps.CustomOverlay({ position: pos, content, yAnchor: 1.2 });
    overlay.setMap(S.mapInst);
    S.markers.push(overlay);
  });

  path.forEach(lp => bounds.extend(lp));
  S.mapInst.setBounds(bounds);
}

// ============================================================
// WAYPOINTS
// ============================================================
function genId() { return '_' + Math.random().toString(36).slice(2, 9); }

function createWaypoint() {
  return { id: genId(), address: '', x: '', y: '', region: '' };
}

function renderWaypoints() {
  const list = document.getElementById('waypoints-list');
  list.innerHTML = '';
  S.waypoints.forEach((wp, i) => {
    const li = document.createElement('li');
    li.className = 'wp-item';
    li.dataset.id = wp.id;

    // Number badge
    const num = document.createElement('div');
    num.className = 'wp-num';
    num.textContent = i + 1;

    // Text input (직접 입력)
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wp-addr-input' + (wp.address ? ' filled' : '');
    input.placeholder = '주소 직접 입력…';
    input.value = wp.address || '';
    input.dataset.idx = i;

    // Tab: 다음 경유지로 이동
    input.addEventListener('keydown', e => {
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        const inputs = document.querySelectorAll('.wp-addr-input');
        if (inputs[i + 1]) inputs[i + 1].focus();
        else document.getElementById('btn-calc').focus();
      }
      if (e.key === 'Enter') {
        if (e.isComposing) return; // 한글 끝 글자 중복 입력 방지
        input.blur();
      }
    });

    // blur: REST API로 자동 좌표 조회
    input.addEventListener('blur', async () => {
      const val = input.value.trim();
      if (!val) {
        S.waypoints[i] = { ...S.waypoints[i], address: '', x: '', y: '' };
        input.classList.remove('filled', 'error', 'geocoding');
        return;
      }
      if (val === S.waypoints[i].address && S.waypoints[i].x) return; // 변화없음
      S.waypoints[i].address = val;
      input.classList.add('geocoding');
      input.classList.remove('error');
      try {
        const result = await geocodeByRest(val);
        if (result) {
          S.waypoints[i].x = result.x;
          S.waypoints[i].y = result.y;
          input.classList.add('filled');
          input.classList.remove('error');
        } else {
          S.waypoints[i].x = '';
          S.waypoints[i].y = '';
          input.classList.add('error');
          toast('주소를 찾지 못했습니다. 🔍 버튼으로 직접 검색해보세요', 3000);
        }
      } catch {
        S.waypoints[i].x = '';
        S.waypoints[i].y = '';
        input.classList.add('error');
      } finally {
        input.classList.remove('geocoding');
      }
    });

    // 🔍 Daum Postcode 보조 검색 버튼
    const searchBtn = document.createElement('button');
    searchBtn.className = 'wp-search-btn';
    searchBtn.title = '주소 검색 (팝업)';
    searchBtn.textContent = '🔍';
    searchBtn.addEventListener('click', () => openAddressSearch(i));

    // Action buttons
    const btns = document.createElement('div');
    btns.className = 'wp-btns';
    const mkBtn = (emoji, cls, title, fn) => {
      const b = document.createElement('button');
      b.className = `wp-btn ${cls}`; b.title = title; b.textContent = emoji;
      b.addEventListener('click', fn); return b;
    };
    btns.append(
      mkBtn('↑', '', '위로 이동', () => moveWp(i, -1)),
      mkBtn('↓', '', '아래로 이동', () => moveWp(i, 1)),
      mkBtn('✕', 'del', '삭제', () => removeWp(i))
    );
    btns.children[0].disabled = i === 0;
    btns.children[1].disabled = i === S.waypoints.length - 1;

    li.append(num, input, searchBtn, btns);
    list.appendChild(li);
  });
}

function addWp() {
  S.waypoints.push(createWaypoint());
  renderWaypoints();
}

function removeWp(i) {
  S.waypoints.splice(i, 1);
  renderWaypoints();
}

function moveWp(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= S.waypoints.length) return;
  [S.waypoints[i], S.waypoints[j]] = [S.waypoints[j], S.waypoints[i]];
  renderWaypoints();
}

function resetWaypoints() {
  S.waypoints = Array.from({ length: 3 }, createWaypoint); // 기본 3개
  renderWaypoints();
  clearResults();
}

// ============================================================
// ADDRESS SEARCH
// ============================================================
async function openAddressSearch(wpIdx) {
  S.pendingWpIdx = wpIdx;
  await loadDaumPostcode();
  const wrap = document.getElementById('postcode-wrap');
  wrap.innerHTML = '';
  openModal('modal-postcode');
  // 설정의 기본 지역 필터 적용
  const region = S.settings.defaultRegion || '';
  new daum.Postcode({
    width: '100%', height: '100%',
    // 지역윤 hint: Daum Postcode 자체는 지역필터 미지원, 선택 후 중복체크로 대응
    oncomplete(data) {
      closeModal('modal-postcode');
      handlePostcodeResult(data, region);
    }
  }).embed(wrap);
}

function handlePostcodeResult(data, globalRegion) {
  const address = data.roadAddress || data.jibunAddress;
  // 설정의 지역필터가 설정되어 있으면 중복 확인 스킵
  if (globalRegion) {
    geocodeAndSet(S.pendingWpIdx, address, data);
    return;
  }

  // Check for duplicate addresses across regions using Kakao Geocoder
  if (!window.kakao?.maps?.services) {
    geocodeAndSet(S.pendingWpIdx, address, data);
    return;
  }

  const geocoder = new kakao.maps.services.Geocoder();
  // Search with just dong+bunji (strip leading city)
  const parts = data.jibunAddress.split(' ');
  const shortQuery = parts.length >= 3 ? parts.slice(2).join(' ') : data.jibunAddress;

  geocoder.addressSearch(shortQuery, (result, status) => {
    if (status !== kakao.maps.services.Status.OK || result.length <= 1) {
      geocodeAndSet(S.pendingWpIdx, address, data, result?.[0]);
      return;
    }
    // Check distinct regions
    const regionSet = new Set(result.map(r => r.address.region_1depth_name + ' ' + r.address.region_2depth_name));
    if (regionSet.size <= 1) {
      geocodeAndSet(S.pendingWpIdx, address, data, result[0]);
    } else {
      S.pendingPostcodeData = { data, result };
      showAmbigModal(result);
    }
  });
}

function showAmbigModal(results) {
  const list = document.getElementById('ambig-list');
  list.innerHTML = '';
  results.forEach(r => {
    const li = document.createElement('li');
    li.className = 'ambig-item';
    const addr = r.road_address ? r.road_address.address_name : r.address.address_name;
    li.innerHTML = `<div class="ambig-region">${r.address.region_1depth_name} ${r.address.region_2depth_name}</div>${addr}`;
    li.addEventListener('click', () => {
      closeModal('modal-ambig');
      setWpFromGeoResult(S.pendingWpIdx, r);
    });
    list.appendChild(li);
  });
  openModal('modal-ambig');
}

function geocodeAndSet(idx, address, postcodeData, geoResult) {
  if (geoResult) {
    setWpFromGeoResult(idx, geoResult);
    return;
  }
  // Fallback: geocode full address
  if (!window.kakao?.maps?.services) {
    setWpAddr(idx, address, '', '');
    return;
  }
  const geocoder = new kakao.maps.services.Geocoder();
  geocoder.addressSearch(address, (result, status) => {
    if (status === kakao.maps.services.Status.OK && result[0]) {
      setWpFromGeoResult(idx, result[0]);
    } else {
      setWpAddr(idx, address, '', '');
    }
  });
}

function setWpFromGeoResult(idx, r) {
  // 지번 주소 우선 (도로명 폴백)
  const addr = r.address?.address_name || r.road_address?.address_name;
  setWpAddr(idx, addr, r.x, r.y);
}

function setWpAddr(idx, address, x, y) {
  if (!S.waypoints[idx]) return;
  S.waypoints[idx].address = address;
  S.waypoints[idx].x = x;
  S.waypoints[idx].y = y;
  // 해당 행의 텍스트 입력상자 값만 업데이트 (전체 render 좁화 회듸)
  const inputs = document.querySelectorAll('.wp-addr-input');
  if (inputs[idx]) {
    inputs[idx].value = address;
    inputs[idx].classList.toggle('filled', !!address);
    inputs[idx].classList.remove('error', 'geocoding');
  }
}

// ============================================================
// ROUTE CALCULATION
// ============================================================
async function calcRoute() {
  const filledWps = S.waypoints.filter(wp => wp.address);
  if (filledWps.length === 0) {
    toast('경유지 주소를 1개 이상 입력해주세요');
    return;
  }

  const fixOffice = S.settings.fixOffice;
  let allPoints;

  if (fixOffice) {
    const officeX = S.settings.officeX, officeY = S.settings.officeY;
    if (!officeX) { toast('설정에서 사무실 주소를 먼저 입력해주세요'); openModal('modal-settings'); return; }
    allPoints = [
      { address: S.settings.officeAddr, alias: '사무실', x: officeX, y: officeY },
      ...filledWps,
      { address: S.settings.officeAddr, alias: '사무실', x: officeX, y: officeY }
    ];
  } else {
    // 고정 해제 — 첫 경유지가 출발, 마지막이 도착
    if (filledWps.length < 2) { toast('고정 해제 모드에서는 경유지 2개 이상 입력해주세요'); return; }
    allPoints = [...filledWps];
  }

  const missingCoords = filledWps.some(p => !p.x || !p.y);
  if (missingCoords) { toast('좌표를 찾지 못한 경유지가 있습니다. 다시 입력해주세요'); return; }

  const loading = document.getElementById('map-loading');
  loading.style.display = 'flex';
  document.getElementById('btn-calc').disabled = true;

  try {
    const { segments, routeCoords } = await callDirectionsAPI(allPoints);
    S.segments = segments;
    S.totalDist = segments.reduce((s, seg) => s + seg.distance, 0);
    renderResults();
    renderMapRoute(allPoints, routeCoords);
  } catch (err) {
    toast('경로 계산 실패: ' + err.message, 4000);
  } finally {
    loading.style.display = 'none';
    document.getElementById('btn-calc').disabled = false;
  }
}

async function callDirectionsAPI(points) {
  const { restKey } = S.settings;
  if (!restKey) throw new Error('REST API 키가 설정되지 않았습니다');

  const MAX_WP = 5;
  const waypoints = points.slice(1, -1);
  const origin = points[0];
  const dest = points[points.length - 1];

  let allSegments = [];
  let allRouteCoords = [];

  if (waypoints.length <= MAX_WP) {
    const res = await fetchDirections(origin, dest, waypoints, restKey);
    return { segments: buildSegments(points, res), routeCoords: extractCoords(res) };
  }

  // Split into chunks
  let cur = origin;
  let remaining = [...waypoints];
  let segPoints = [origin];

  while (remaining.length > 0) {
    const chunk = remaining.splice(0, MAX_WP - (remaining.length > MAX_WP ? 1 : 0));
    const chunkDest = remaining.length > 0 ? chunk[chunk.length - 1] : dest;
    const chunkWps = remaining.length > 0 ? chunk.slice(0, -1) : chunk;

    const chunkAllPts = [cur, ...chunkWps, chunkDest];
    if (!segPoints.includes(cur)) segPoints.push(cur);
    chunkWps.forEach(p => segPoints.push(p));

    const res = await fetchDirections(cur, chunkDest, chunkWps, restKey);
    allSegments.push(...buildSegments(chunkAllPts, res));
    allRouteCoords.push(...extractCoords(res));
    cur = chunkDest;
  }
  segPoints.push(dest);

  return { segments: allSegments, routeCoords: allRouteCoords };
}

async function fetchDirections(origin, dest, waypoints, restKey) {
  const body = {
    origin: { x: String(origin.x), y: String(origin.y) },
    destination: { x: String(dest.x), y: String(dest.y) },
    waypoints: waypoints.map(w => ({ x: String(w.x), y: String(w.y) })),
    priority: 'RECOMMEND'
  };

  const resp = await fetch('https://apis-navi.kakaomobility.com/v1/waypoints/directions', {
    method: 'POST',
    headers: { 'Authorization': `KakaoAK ${restKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`API 오류 (${resp.status}): ${txt}`);
  }
  const json = await resp.json();
  if (!json.routes?.[0]) throw new Error('경로 결과 없음');
  if (json.routes[0].result_code !== 0) throw new Error(json.routes[0].result_msg || '경로 계산 실패');
  return json.routes[0];
}

function buildSegments(points, route) {
  return route.sections.map((sec, i) => ({
    from: points[i]?.alias || points[i]?.address || '',
    to: points[i + 1]?.alias || points[i + 1]?.address || '',
    distance: Math.round(sec.distance / 100) / 10 // m → km (1 decimal)
  }));
}

function extractCoords(route) {
  const coords = [];
  route.sections?.forEach(sec => {
    sec.roads?.forEach(road => {
      for (let i = 0; i < road.vertexes.length; i += 2) {
        coords.push([road.vertexes[i], road.vertexes[i + 1]]);
      }
    });
  });
  return coords;
}

// ============================================================
// RESULTS
// ============================================================
function renderResults() {
  const tbody = document.getElementById('segments-body');
  tbody.innerHTML = '';
  S.segments.forEach((seg, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${seg.from}">${seg.from}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${seg.to}">${seg.to}</td>
      <td><strong>${seg.distance.toFixed(1)}</strong></td>
      <td><button class="copy-seg-btn" data-i="${i}" title="도착지명 복사">📋</button></td>
    `;
    tbody.appendChild(tr);
  });
  const totalText = S.totalDist.toFixed(1) + ' km';
  document.getElementById('total-km').textContent = totalText;
  const foot = document.getElementById('total-km-foot');
  if (foot) foot.textContent = totalText;

  document.getElementById('results-placeholder').style.display = 'none';
  document.getElementById('results-card').style.display = 'block';
}

function clearResults() {
  S.segments = []; S.totalDist = 0;
  document.getElementById('results-placeholder').style.display = 'flex';
  document.getElementById('results-card').style.display = 'none';
  clearMapOverlays();
}

// ============================================================
// COPY
// ============================================================
function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy'); document.body.removeChild(ta);
}

function copyWpAddr(idx) {
  const addr = S.waypoints[idx]?.address;
  if (!addr) { toast('주소가 없습니다'); return; }
  copyText(addr);
  toast('주소가 복사되었습니다 📋');
  // Visual feedback on button
  const btns = document.querySelectorAll('.wp-btn.cp');
  if (btns[idx]) {
    btns[idx].textContent = '✅';
    setTimeout(() => { btns[idx].textContent = '📋'; }, 1500);
  }
}

// Segment copy — 도착지명(경유지명) 복사
document.getElementById('segments-body').addEventListener('click', e => {
  const btn = e.target.closest('.copy-seg-btn');
  if (!btn) return;
  const i = parseInt(btn.dataset.i);
  const seg = S.segments[i];
  if (!seg) return;
  copyText(seg.to); // 도착지명(경유지명)만 복사
  btn.textContent = '✅';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = '📋'; btn.classList.remove('copied'); }, 1500);
  toast(`복사됨: ${seg.to}`);
});


// ============================================================
// HISTORY
// ============================================================
function saveHistory() {
  if (!S.segments.length) { toast('먼저 경로를 계산해주세요'); return; }
  const record = {
    id: genId(),
    date: new Date().toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }),
    totalDist: S.totalDist,
    waypoints: S.waypoints.map(w => ({ ...w })),
    segments: S.segments.map(s => ({ ...s }))
  };
  S.history.unshift(record);
  if (S.history.length > 20) S.history.pop();
  save('drvlog_history', S.history);
  renderHistory();
  toast('운행일지가 저장되었습니다 💾');
}

function renderHistory() {
  const el = document.getElementById('history-list');
  el.innerHTML = '';
  if (!S.history.length) {
    el.innerHTML = '<p class="empty-msg">저장된 이력이 없습니다.</p>';
    return;
  }
  S.history.forEach((h, hi) => {
    const div = document.createElement('div');
    div.className = 'hist-item';
    div.innerHTML = `
      <div class="hist-date">${h.date || ''}</div>
      <div class="hist-km">${h.totalDist?.toFixed(1)} km</div>
      <div class="hist-btns">
        <button class="hist-btn" data-hi="${hi}">불러오기</button>
        <button class="hist-btn del" data-del="${hi}">삭제</button>
      </div>
    `;
    el.appendChild(div);
  });

  el.querySelectorAll('.hist-btn:not(.del)').forEach(btn => {
    btn.addEventListener('click', () => loadHistory(parseInt(btn.dataset.hi)));
  });
  el.querySelectorAll('.hist-btn.del').forEach(btn => {
    btn.addEventListener('click', () => {
      S.history.splice(parseInt(btn.dataset.del), 1);
      save('drvlog_history', S.history);
      renderHistory();
    });
  });
}

function loadHistory(idx) {
  const h = S.history[idx];
  if (!h) return;
  S.waypoints = h.waypoints.map(w => ({ ...w }));
  S.segments = h.segments.map(s => ({ ...s }));
  S.totalDist = h.totalDist;
  renderWaypoints();
  renderResults();
  toast('이력을 불러왔습니다. 경로 계산 버튼으로 최신 경로를 확인하세요.');
}

// ============================================================
// SETTINGS
// ============================================================
function openSettings() {
  const st = S.settings;
  // 모달 방식으로 복원
  document.getElementById('set-office-addr').value = st.officeAddr || '';
  document.getElementById('set-office-x').value = st.officeX || '';
  document.getElementById('set-office-y').value = st.officeY || '';
  document.getElementById('set-fix-office').checked = st.fixOffice !== false;
  document.getElementById('set-default-region').value = st.defaultRegion || '';
  openModal('modal-settings');
}

async function saveSettings() {
  const officeAddr = document.getElementById('set-office-addr').value.trim();
  const officeX = document.getElementById('set-office-x').value;
  const officeY = document.getElementById('set-office-y').value;
  const fixOffice = document.getElementById('set-fix-office').checked;
  const defaultRegion = document.getElementById('set-default-region').value;

  // API 키는 코드에 고정된 상수 사용
  S.settings = { jsKey: KAKAO_JS_KEY, restKey: KAKAO_REST_KEY, officeAddr, officeX, officeY, fixOffice, defaultRegion };
  save('drvlog_settings', S.settings);

  updateFixedStops();
  closeModal('modal-settings');
  toast('설정이 저장되었습니다');
}


function updateFixedStops() {
  const addr = S.settings.officeAddr;
  const fixed = S.settings.fixOffice;
  const originEl = document.getElementById('origin-addr-text');
  const destEl = document.getElementById('dest-addr-text');
  const originStop = document.getElementById('origin-stop');
  const destStop = document.getElementById('dest-stop');

  if (fixed) {
    // 사무실 고정 모드
    originStop.style.display = '';
    destStop.style.display = '';
    originEl.textContent = addr || '사무실 주소를 설정해주세요';
    destEl.textContent = addr || '사무실 주소를 설정해주세요';
    originEl.classList.toggle('set', !!addr);
    destEl.classList.toggle('set', !!addr);
  } else {
    // 고정 해제 모드 — 첩 경유지가 출발, 마지막이 도착
    originStop.style.display = 'none';
    destStop.style.display = 'none';
  }
}

async function geocodeByRest(address) {
  const restKey = S.settings.restKey || KAKAO_REST_KEY;
  if (!restKey) return null;

  // 1순위: 주소로 검색 (address.json)
  try {
    const resp = await fetch(
      `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`,
      { headers: { Authorization: `KakaoAK ${restKey}` } }
    );
    const json = await resp.json();
    if (json.documents?.[0]) return { x: json.documents[0].x, y: json.documents[0].y };
  } catch (e) { console.error('Address geocoding failed:', e); }

  // 2순위: 검색결과가 없다면 장소명(키워드)으로 검색 (keyword.json)
  try {
    const resp2 = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(address)}`,
      { headers: { Authorization: `KakaoAK ${restKey}` } }
    );
    const json2 = await resp2.json();
    if (json2.documents?.[0]) return { x: json2.documents[0].x, y: json2.documents[0].y };
  } catch (e) { console.error('Keyword geocoding failed:', e); }

  return null;
}

// Settings: office address search
document.getElementById('btn-search-office').addEventListener('click', async () => {
  await loadDaumPostcode();
  new daum.Postcode({
    async oncomplete(data) {
      const addr = data.roadAddress || data.jibunAddress;
      document.getElementById('set-office-addr').value = addr;
      let coords = null;
      // 1순위: JS SDK Geocoder
      if (window.kakao?.maps?.services) {
        await new Promise(r => {
          new kakao.maps.services.Geocoder().addressSearch(addr, (result, status) => {
            if (status === kakao.maps.services.Status.OK && result[0]) {
              coords = { x: result[0].x, y: result[0].y };
            }
            r();
          });
        });
      }
      // 2순위: REST API (SDK 미로드 상태에서도 동작)
      if (!coords) coords = await geocodeByRest(addr);
      if (coords) {
        document.getElementById('set-office-x').value = coords.x;
        document.getElementById('set-office-y').value = coords.y;
        toast('사무실 주소 좌표 설정 완료 ✅');
      } else {
        toast('좌표 변환 실패 — REST API 키를 입력 후 다시 시도하세요', 4000);
      }
    }
  }).open();
});

// ============================================================
// EVENT LISTENERS
// ============================================================
document.getElementById('btn-settings').addEventListener('click', openSettings);
document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
document.getElementById('btn-add-wp').addEventListener('click', addWp);
document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('경유지를 초기화하시겠습니까?')) resetWaypoints();
});
document.getElementById('btn-calc').addEventListener('click', calcRoute);
document.getElementById('btn-save').addEventListener('click', saveHistory);

// ============================================================
// INIT
// ============================================================
async function init() {
  loadAll();
  updateFixedStops();
  resetWaypoints();

  // Load SDK
  if (S.settings.jsKey) {
    try {
      await loadKakaoSDK(S.settings.jsKey);
      initMap();
    } catch (e) {
      console.warn('Kakao SDK load failed:', e.message);
    }
  } else {
    setTimeout(() => { toast('⚙️ 설정에서 사무실 주소를 입력해주세요', 4000); }, 600);
    openSettings();
  }
}

init();
