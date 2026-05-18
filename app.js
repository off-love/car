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
    defaultRegion: '', // 기본 지역 필터
    weatherEnabled: false
  },
  waypoints: [], // [{id,address,x,y,region}]
  segments: [],  // [{from,to,fromAddr,toAddr,distance,duration}]
  totalDist: 0,
  mapInst: null,
  markers: [],
  polylines: [],
  favorites: [],
  savedRoutes: [], // 저장된 경로 (최대 3건)
  ocrCandidates: [],
  pendingWpIdx: null,    // 주소 검색 대상 waypoint index
  pendingPostcodeData: null, // 중복 주소 확인 대기 데이터
  kakaoLoaded: false,
  weatherRequestId: 0
};

const REGIONS = [
  ['전국', ''], ['서울', '서울'], ['경기', '경기'], ['인천', '인천'],
  ['부산', '부산'], ['대구', '대구'], ['대전', '대전'], ['광주', '광주'],
  ['울산', '울산'], ['세종', '세종'], ['강원', '강원'], ['충북', '충청북도'],
  ['충남', '충청남도'], ['전북', '전라북도'], ['전남', '전라남도'],
  ['경북', '경상북도'], ['경남', '경상남도'], ['제주', '제주']
];

const WEATHER_LAST_HOUR = 22;
const WEATHER_ICON_KINDS = new Set(['clear', 'cloud', 'overcast']);
const WEATHER_FORECAST_TIMEOUT_MS = 7000;
const WEATHER_LOCATION_TIMEOUT_MS = 3500;
const OCR_MAX_ADDRESSES = 10;
const OCR_PREPROCESS_MAX_SIDE = 3200;
const OCR_PREPROCESS_MIN_LONG_SIDE = 1600;

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
  S.savedRoutes = load('drvlog_saved_routes') || [];
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
// HEADER WEATHER
// ============================================================
function getSeoulDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const pick = type => parts.find(part => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function parseSeoulTime(value) {
  return new Date(`${value}+09:00`);
}

function getWeatherHourStart(date = new Date()) {
  const zoned = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const hour = zoned.getMinutes() || zoned.getSeconds() || zoned.getMilliseconds()
    ? zoned.getHours() + 1
    : zoned.getHours();
  return Math.min(hour, 24);
}

function getVisibleWeatherHours(date = new Date()) {
  const startHour = getWeatherHourStart(date);
  if (startHour > WEATHER_LAST_HOUR) return [];
  const hours = [];
  for (let hour = startHour; hour <= WEATHER_LAST_HOUR; hour += 2) {
    hours.push(hour);
  }
  if (hours[hours.length - 1] !== WEATHER_LAST_HOUR) hours.push(WEATHER_LAST_HOUR);
  return hours;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getShortRegionName(region) {
  const names = {
    서울특별시: '서울',
    부산광역시: '부산',
    대구광역시: '대구',
    인천광역시: '인천',
    광주광역시: '광주',
    대전광역시: '대전',
    울산광역시: '울산',
    세종특별자치시: '세종',
    경기도: '경기',
    강원특별자치도: '강원',
    강원도: '강원',
    충청북도: '충북',
    충청남도: '충남',
    전북특별자치도: '전북',
    전라북도: '전북',
    전라남도: '전남',
    경상북도: '경북',
    경상남도: '경남',
    제주특별자치도: '제주'
  };
  return names[region] || (region || '').replace(/(특별자치시|특별자치도|특별시|광역시|도)$/u, '');
}

function formatWeatherLocation(region1, locality) {
  const first = getShortRegionName(region1);
  const second = (locality || '').trim();
  return [first, second].filter(Boolean).join(' ');
}

function getWeatherLocationFromAddress(address) {
  const parts = (address || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const locality = parts.find(part => /(동|읍|면)$/u.test(part)) || parts[1] || '';
  return formatWeatherLocation(parts[0], locality);
}

async function getWeatherLocationLabel(latitude, longitude) {
  const fallback = getWeatherLocationFromAddress(S.settings.officeAddr);
  const restKey = S.settings.restKey || KAKAO_REST_KEY;
  if (!restKey) return fallback;

  try {
    const params = new URLSearchParams({ x: longitude, y: latitude });
    const resp = await fetchWithTimeout(
      `https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?${params}`,
      { headers: { Authorization: `KakaoAK ${restKey}` } },
      WEATHER_LOCATION_TIMEOUT_MS
    );
    if (!resp.ok) throw new Error(`Kakao region ${resp.status}`);
    const json = await resp.json();
    const docs = json.documents || [];
    const doc = docs.find(item => item.region_type === 'B') || docs[0];
    if (!doc) return fallback;
    return formatWeatherLocation(doc.region_1depth_name, doc.region_3depth_name || doc.region_2depth_name) || fallback;
  } catch (e) {
    console.warn('Weather location load failed:', e);
    return fallback;
  }
}

function getWeatherKind(code, precipProbability = 0) {
  const c = Number(code);
  const p = Number(precipProbability) || 0;
  if ([95, 96, 99].includes(c)) return 'storm';
  if ([71, 73, 75, 77, 85, 86].includes(c)) return 'snow';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(c)) return 'rain';
  if ([45, 48].includes(c)) return 'fog';
  if (p >= 60) return 'rain';
  if (c === 3) return 'overcast';
  if ([1, 2].includes(c)) return 'cloud';
  if (c === 0) return 'clear';
  return 'unknown';
}

function getWeatherText(code, precipProbability = 0) {
  const kind = getWeatherKind(code, precipProbability);
  return {
    storm: '뇌우',
    snow: '눈',
    rain: '비',
    fog: '안개',
    overcast: '흐림',
    cloud: '구름',
    clear: '맑음',
    unknown: '날씨'
  }[kind];
}

function createWeatherDesc(code, precipProbability = 0) {
  const kind = getWeatherKind(code, precipProbability);
  const text = getWeatherText(code, precipProbability);
  const el = document.createElement('span');
  if (WEATHER_ICON_KINDS.has(kind)) {
    el.className = `weather-icon weather-icon-${kind}`;
    el.setAttribute('aria-label', text);
    el.title = text;
  } else {
    el.className = 'weather-desc';
    el.textContent = text;
  }
  return el;
}

function formatTemp(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : '-';
}

function hideHeaderWeather() {
  const weatherEl = document.getElementById('header-weather');
  if (!weatherEl) return;
  weatherEl.hidden = true;
  const locationEl = document.getElementById('weather-location');
  if (locationEl) locationEl.textContent = '';
  document.getElementById('weather-hourly')?.replaceChildren();
  const tomorrowEl = document.getElementById('weather-tomorrow');
  if (tomorrowEl) tomorrowEl.textContent = '';
}

function renderHeaderWeatherLoading(locationLabel) {
  const weatherEl = document.getElementById('header-weather');
  const locationEl = document.getElementById('weather-location');
  const hourlyEl = document.getElementById('weather-hourly');
  const tomorrowEl = document.getElementById('weather-tomorrow');
  if (!weatherEl || !locationEl || !hourlyEl || !tomorrowEl) return;

  weatherEl.hidden = false;
  locationEl.textContent = locationLabel || '날씨';
  hourlyEl.replaceChildren();
  const loading = document.createElement('span');
  loading.className = 'weather-status';
  loading.textContent = '날씨 불러오는 중';
  hourlyEl.append(loading);
  tomorrowEl.replaceChildren();
}

function renderHeaderWeatherError(locationLabel) {
  const weatherEl = document.getElementById('header-weather');
  const locationEl = document.getElementById('weather-location');
  const hourlyEl = document.getElementById('weather-hourly');
  const tomorrowEl = document.getElementById('weather-tomorrow');
  if (!weatherEl || !locationEl || !hourlyEl || !tomorrowEl) return;

  weatherEl.hidden = false;
  locationEl.textContent = locationLabel || '날씨';
  hourlyEl.replaceChildren();
  const error = document.createElement('span');
  error.className = 'weather-status weather-status-error';
  error.textContent = '예보를 불러오지 못했습니다';
  hourlyEl.append(error);
  tomorrowEl.replaceChildren();
}

function createDailyWeatherCard(label, daily, idx) {
  const card = document.createElement('div');
  card.className = 'weather-day-card';

  const dayLabel = document.createElement('span');
  dayLabel.className = 'weather-tomorrow-label';
  dayLabel.textContent = label;

  const dayIcon = document.createElement('span');
  dayIcon.className = 'weather-icon-cell';
  dayIcon.append(createWeatherDesc(daily.weather_code?.[idx], daily.precipitation_probability_max?.[idx]));

  const maxTemp = formatTemp(daily.temperature_2m_max?.[idx]);
  const minTemp = formatTemp(daily.temperature_2m_min?.[idx]);
  const dayTemp = document.createElement('span');
  dayTemp.className = 'weather-tomorrow-temp';
  dayTemp.textContent = `${maxTemp}/${minTemp}°`;

  card.append(dayLabel, dayIcon, dayTemp);
  return card;
}

function renderHeaderWeather(data, locationLabel) {
  const weatherEl = document.getElementById('header-weather');
  const locationEl = document.getElementById('weather-location');
  const hourlyEl = document.getElementById('weather-hourly');
  const tomorrowEl = document.getElementById('weather-tomorrow');
  if (!weatherEl || !locationEl || !hourlyEl || !tomorrowEl) return;

  const now = new Date();
  const todayKey = getSeoulDateKey(now);
  const tomorrowKey = getSeoulDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const dayAfterTomorrowKey = getSeoulDateKey(new Date(now.getTime() + 48 * 60 * 60 * 1000));
  const times = data.hourly?.time || [];
  const temps = data.hourly?.temperature_2m || [];
  const codes = data.hourly?.weather_code || [];
  const probabilities = data.hourly?.precipitation_probability || [];
  const visibleHours = new Set(getVisibleWeatherHours(now));
  const todayForecast = times
    .map((time, i) => ({
      date: parseSeoulTime(time),
      temp: temps[i],
      code: codes[i],
      probability: probabilities[i]
    }))
    .filter(item => getSeoulDateKey(item.date) === todayKey && visibleHours.has(item.date.getHours()));

  hourlyEl.replaceChildren();
  locationEl.textContent = locationLabel || getWeatherLocationFromAddress(S.settings.officeAddr) || '날씨';
  if (!todayForecast.length) {
    const empty = document.createElement('span');
    empty.className = 'weather-status';
    empty.textContent = '남은 예보 없음';
    hourlyEl.append(empty);
  } else {
    const axis = document.createElement('div');
    axis.className = 'weather-axis-stack';
    ['시간', '날씨', '기온'].forEach(label => {
      const item = document.createElement('span');
      item.textContent = label;
      axis.append(item);
    });
    hourlyEl.append(axis);

    todayForecast.forEach(item => {
      const hour = item.date.getHours();
      const probability = Number(item.probability) || 0;
      const col = document.createElement('div');
      col.className = 'weather-hour-column';

      const timeEl = document.createElement('span');
      timeEl.className = 'weather-time';
      timeEl.textContent = `${hour}시`;

      const iconWrap = document.createElement('span');
      iconWrap.className = 'weather-icon-cell';
      iconWrap.append(createWeatherDesc(item.code, probability));

      const tempEl = document.createElement('span');
      tempEl.className = 'weather-temp-cell';
      tempEl.textContent = `${formatTemp(item.temp)}°`;

      col.append(timeEl, iconWrap, tempEl);
      hourlyEl.append(col);
    });
  }

  const daily = data.daily || {};
  const tomorrowIdx = (daily.time || []).indexOf(tomorrowKey);
  const dayAfterTomorrowIdx = (daily.time || []).indexOf(dayAfterTomorrowKey);
  const tomorrowDailyIdx = tomorrowIdx >= 0 ? tomorrowIdx : 1;
  const dayAfterTomorrowDailyIdx = dayAfterTomorrowIdx >= 0 ? dayAfterTomorrowIdx : 2;
  tomorrowEl.replaceChildren();
  tomorrowEl.append(
    createDailyWeatherCard('내일', daily, tomorrowDailyIdx),
    createDailyWeatherCard('모레', daily, dayAfterTomorrowDailyIdx)
  );
  weatherEl.hidden = false;
}

async function updateHeaderWeather() {
  const reqId = ++S.weatherRequestId;

  if (!S.settings.weatherEnabled) {
    hideHeaderWeather();
    return;
  }

  const latitude = Number(S.settings.officeY);
  const longitude = Number(S.settings.officeX);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    hideHeaderWeather();
    return;
  }

  const fallbackLocation = getWeatherLocationFromAddress(S.settings.officeAddr);
  renderHeaderWeatherLoading(fallbackLocation);
  let locationLabel = fallbackLocation;
  getWeatherLocationLabel(latitude, longitude).then(label => {
    if (reqId !== S.weatherRequestId || !label) return;
    locationLabel = label;
    const locationEl = document.getElementById('weather-location');
    if (locationEl) locationEl.textContent = label;
  });

  const params = new URLSearchParams({
    latitude,
    longitude,
    hourly: 'temperature_2m,precipitation_probability,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'Asia/Seoul',
    forecast_days: '3'
  });

  try {
    const resp = await fetchWithTimeout(
      `https://api.open-meteo.com/v1/forecast?${params}`,
      {},
      WEATHER_FORECAST_TIMEOUT_MS
    );
    if (!resp.ok) throw new Error(`Open-Meteo ${resp.status}`);
    const data = await resp.json();
    if (reqId !== S.weatherRequestId) return;
    renderHeaderWeather(data, locationLabel);
  } catch (e) {
    console.warn('Weather load failed:', e);
    if (reqId === S.weatherRequestId) renderHeaderWeatherError(locationLabel);
  }
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

let tesseractLoadPromise;
let ocrPreviewUrl = '';
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (tesseractLoadPromise) return tesseractLoadPromise;

  tesseractLoadPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    s.onload = () => window.Tesseract ? res(window.Tesseract) : rej(new Error('OCR 라이브러리 초기화 실패'));
    s.onerror = () => rej(new Error('OCR 라이브러리 로드 실패'));
    document.head.appendChild(s);
  }).catch(err => {
    tesseractLoadPromise = null;
    throw err;
  });
  return tesseractLoadPromise;
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
let draggedWpId = null;
let activeWpDrag = null;

function genId() { return '_' + Math.random().toString(36).slice(2, 9); }

function createWaypoint() {
  return { id: genId(), address: '', x: '', y: '', region: '' };
}

function getWaypointIndexById(id) {
  return S.waypoints.findIndex(wp => wp.id === id);
}

function clearWaypointDropIndicators() {
  document.querySelectorAll('.wp-item.drag-over-before, .wp-item.drag-over-after')
    .forEach(el => el.classList.remove('drag-over-before', 'drag-over-after'));
}

function createWaypointDragPreview(item, pointerY) {
  const rect = item.getBoundingClientRect();
  const preview = item.cloneNode(true);
  const sourceInputs = item.querySelectorAll('input');
  const previewInputs = preview.querySelectorAll('input');

  previewInputs.forEach((input, idx) => {
    input.value = sourceInputs[idx]?.value || '';
    input.setAttribute('readonly', 'readonly');
    input.tabIndex = -1;
  });

  preview.classList.remove('dragging', 'drag-over-before', 'drag-over-after');
  preview.classList.add('wp-drag-preview');
  preview.style.left = `${rect.left}px`;
  preview.style.top = `${rect.top}px`;
  preview.style.width = `${rect.width}px`;
  preview.style.height = `${rect.height}px`;

  document.body.appendChild(preview);
  return { preview, offsetY: pointerY - rect.top };
}

function updateWaypointDragPreview(drag, pointerY) {
  if (!drag?.preview) return;
  drag.preview.style.top = `${pointerY - drag.offsetY}px`;
}

function syncWaypointInputs() {
  document.querySelectorAll('.wp-item').forEach(item => {
    const wpIdx = getWaypointIndexById(item.dataset.id);
    const input = item.querySelector('.wp-addr-input');
    if (wpIdx < 0 || !input) return;

    const val = input.value.trim();
    if (!val) {
      S.waypoints[wpIdx] = { ...S.waypoints[wpIdx], address: '', x: '', y: '' };
      return;
    }

    if (val !== S.waypoints[wpIdx].address) {
      S.waypoints[wpIdx] = { ...S.waypoints[wpIdx], address: val, x: '', y: '' };
    }
  });
}

function getWaypointDropTarget(clientY, excludeId) {
  const items = Array.from(document.querySelectorAll('.wp-item'))
    .filter(item => item.dataset.id !== excludeId);

  let lastTarget = null;
  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (clientY < midpoint) {
      return { id: item.dataset.id, placeAfter: false };
    }
    lastTarget = { id: item.dataset.id, placeAfter: true };
  }
  return lastTarget;
}

function showWaypointDropTarget(target) {
  clearWaypointDropIndicators();
  if (!target) return;
  const item = document.querySelector(`.wp-item[data-id="${target.id}"]`);
  if (item) item.classList.add(target.placeAfter ? 'drag-over-after' : 'drag-over-before');
}

function dropWaypointAt(fromId, target) {
  if (!fromId || !target || fromId === target.id) return;

  const fromIdx = getWaypointIndexById(fromId);
  const targetIdx = getWaypointIndexById(target.id);
  if (fromIdx < 0 || targetIdx < 0) return;

  let toIdx = targetIdx + (target.placeAfter ? 1 : 0);
  if (fromIdx < toIdx) toIdx -= 1;
  moveWpTo(fromIdx, toIdx);
}

function endWaypointDrag() {
  if (activeWpDrag?.item) activeWpDrag.item.classList.remove('dragging');
  if (activeWpDrag?.preview) activeWpDrag.preview.remove();
  activeWpDrag = null;
  draggedWpId = null;
  clearWaypointDropIndicators();
}

function moveWpTo(fromIdx, toIdx) {
  if (fromIdx === toIdx) return;
  if (fromIdx < 0 || fromIdx >= S.waypoints.length) return;
  if (toIdx < 0 || toIdx >= S.waypoints.length) return;

  syncWaypointInputs();
  const [wp] = S.waypoints.splice(fromIdx, 1);
  S.waypoints.splice(toIdx, 0, wp);
  renderWaypoints();
}

function renderWaypoints() {
  const list = document.getElementById('waypoints-list');
  list.innerHTML = '';
  S.waypoints.forEach((wp, i) => {
    const wpId = wp.id;
    const li = document.createElement('li');
    li.className = 'wp-item';
    li.dataset.id = wpId;

    // Drag handle
    const dragHandle = document.createElement('button');
    dragHandle.type = 'button';
    dragHandle.className = 'wp-drag-handle';
    dragHandle.title = '드래그해서 순서 변경';
    dragHandle.setAttribute('aria-label', `${i + 1}번 경유지 순서 변경`);
    dragHandle.innerHTML = '<span class="wp-drag-arrow up"></span><span class="wp-drag-arrow down"></span>';
    dragHandle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();

      draggedWpId = wpId;
      const { preview, offsetY } = createWaypointDragPreview(li, e.clientY);
      activeWpDrag = { id: wpId, item: li, target: null, preview, offsetY };
      li.classList.add('dragging');
      dragHandle.setPointerCapture(e.pointerId);

      const onPointerMove = moveEvent => {
        if (!activeWpDrag || moveEvent.pointerId !== e.pointerId) return;
        updateWaypointDragPreview(activeWpDrag, moveEvent.clientY);
        activeWpDrag.target = getWaypointDropTarget(moveEvent.clientY, wpId);
        showWaypointDropTarget(activeWpDrag.target);
      };
      const onPointerUp = upEvent => {
        if (upEvent.pointerId !== e.pointerId) return;
        if (activeWpDrag?.target) dropWaypointAt(activeWpDrag.id, activeWpDrag.target);
        endWaypointDrag();
        controller.abort();
      };
      const onPointerCancel = cancelEvent => {
        if (cancelEvent.pointerId !== e.pointerId) return;
        endWaypointDrag();
        controller.abort();
      };
      const controller = new AbortController();
      document.addEventListener('pointermove', onPointerMove, { signal: controller.signal });
      document.addEventListener('pointerup', onPointerUp, { signal: controller.signal });
      document.addEventListener('pointercancel', onPointerCancel, { signal: controller.signal });
    });
    dragHandle.addEventListener('keydown', e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      moveWp(i, e.key === 'ArrowUp' ? -1 : 1);
    });

    // Number badge
    const num = document.createElement('div');
    num.className = 'wp-num';
    num.textContent = i + 1;

    // Text input (직접 입력)
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'wp-addr-input' + (wp.address ? ' filled' : '');
    input.placeholder = '주소 입력';
    input.value = wp.address || '';
    input.title = wp.address || ''; // 마우스 오버 시 전체 주소 표시
    input.dataset.idx = i;

    // 엔터키 : 포커스 해제 (입력 완료 처리)
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        if (e.isComposing) return; // 한글 끝 글자 중복 입력 방지
        input.blur();
      }
    });

    // blur: REST API로 자동 좌표 조회
    input.addEventListener('blur', () => {
      // 한글 조합이 끝난 최종 value를 얻기 위해 약간의 지연
      setTimeout(async () => {
        const val = input.value.trim();
        const wpIdx = getWaypointIndexById(wpId);
        if (wpIdx < 0) return;

        if (!val) {
          S.waypoints[wpIdx] = { ...S.waypoints[wpIdx], address: '', x: '', y: '' };
          input.classList.remove('filled', 'error', 'geocoding');
          return;
        }
        if (val === S.waypoints[wpIdx].address && S.waypoints[wpIdx].x) return; // 변화없음

        S.waypoints[wpIdx].address = val;
        input.title = val; // 툴팁 업데이트
        input.classList.add('geocoding');
        input.classList.remove('error');
        try {
          const result = await geocodeByRest(val);
          const latestWpIdx = getWaypointIndexById(wpId);
          if (latestWpIdx < 0 || S.waypoints[latestWpIdx].address !== val) return;

          if (result) {
            S.waypoints[latestWpIdx].x = result.x;
            S.waypoints[latestWpIdx].y = result.y;
            input.classList.add('filled');
            input.classList.remove('error');
          } else {
            S.waypoints[latestWpIdx].x = '';
            S.waypoints[latestWpIdx].y = '';
            input.classList.add('error');
            toast('주소를 찾지 못했습니다. 검색 버튼으로 직접 검색해보세요', 3000);
          }
        } catch {
          const latestWpIdx = getWaypointIndexById(wpId);
          if (latestWpIdx >= 0) {
            S.waypoints[latestWpIdx].x = '';
            S.waypoints[latestWpIdx].y = '';
          }
          input.classList.add('error');
        } finally {
          input.classList.remove('geocoding');
        }
      }, 50);
    });

    // Daum Postcode 보조 검색 버튼
    const searchBtn = document.createElement('button');
    searchBtn.className = 'wp-search-btn';
    searchBtn.title = '주소 검색 (팝업)';
    searchBtn.innerHTML = '<span class="ui-icon icon-search" aria-hidden="true"></span>';
    searchBtn.tabIndex = -1; // 탭 이동 제외
    searchBtn.addEventListener('click', () => openAddressSearch(i));

    // Action buttons
    const btns = document.createElement('div');
    btns.className = 'wp-btns';
    const mkBtn = (emoji, cls, title, fn) => {
      const b = document.createElement('button');
      b.className = `wp-btn ${cls}`; b.title = title; b.textContent = emoji;
      b.setAttribute('aria-label', title);
      b.tabIndex = -1; // 탭 이동 제외
      b.addEventListener('click', fn); return b;
    };
    btns.append(
      mkBtn('−', 'del', '삭제', () => removeWp(i))
    );

    li.append(num, input, searchBtn, btns, dragHandle);
    list.appendChild(li);
  });
}

function addWp() {
  if (S.waypoints.length >= 10) {
    toast('경유지는 최대 10개까지 추가할 수 있습니다.');
    return;
  }
  syncWaypointInputs();
  S.waypoints.push(createWaypoint());
  renderWaypoints();
}

function removeWp(i) {
  syncWaypointInputs();
  S.waypoints.splice(i, 1);
  renderWaypoints();
}

function moveWp(i, dir) {
  const j = i + dir;
  moveWpTo(i, j);
}

function resetWaypoints() {
  S.waypoints = Array.from({ length: 5 }, createWaypoint); // 기본 5개
  renderWaypoints();
  clearResults();
}

// ============================================================
// OCR ADDRESS IMPORT
// ============================================================
function setOcrStatus(message) {
  const el = document.getElementById('ocr-status');
  if (el) el.textContent = message;
}

function setOcrProgress(progress) {
  const wrap = document.getElementById('ocr-progress');
  const bar = document.getElementById('ocr-progress-bar');
  if (!wrap || !bar) return;

  wrap.style.display = progress == null ? 'none' : '';
  bar.style.width = `${Math.max(4, Math.min(100, Math.round(progress * 100)))}%`;
}

function resetOcrModal() {
  S.ocrCandidates = [];
  document.getElementById('ocr-address-list').innerHTML = '';
  document.getElementById('ocr-empty').style.display = 'none';
  document.getElementById('btn-apply-ocr-addresses').disabled = true;
  document.getElementById('ocr-source-meta').textContent = '캡처 후 여기서 Ctrl+V 또는 ⌘V';
  document.getElementById('ocr-drop-zone').classList.remove('processing', 'paste-ready');
  const preview = document.getElementById('ocr-preview');
  preview.style.display = 'none';
  preview.removeAttribute('src');
  if (ocrPreviewUrl) {
    URL.revokeObjectURL(ocrPreviewUrl);
    ocrPreviewUrl = '';
  }
  setOcrProgress(null);
}

function updateOcrApplyState() {
  const hasAddress = Array.from(document.querySelectorAll('.ocr-address-input'))
    .some(input => input.value.trim());
  document.getElementById('btn-apply-ocr-addresses').disabled = !hasAddress;
}

function setOcrProcessing(processing) {
  document.getElementById('ocr-drop-zone').classList.toggle('processing', processing);
  document.getElementById('btn-apply-ocr-addresses').disabled = processing || !document.querySelector('.ocr-address-input');
}

function showOcrPreview(file) {
  const preview = document.getElementById('ocr-preview');
  if (ocrPreviewUrl) URL.revokeObjectURL(ocrPreviewUrl);
  ocrPreviewUrl = URL.createObjectURL(file);
  preview.src = ocrPreviewUrl;
  preview.style.display = '';
  document.getElementById('ocr-source-meta').textContent = file.name || '클립보드 이미지';
}

async function imageFileToCanvas(file) {
  const maxSide = 2400;
  let width, height, drawSource, closeSource;

  if (window.createImageBitmap) {
    const bitmap = await createImageBitmap(file);
    width = bitmap.width;
    height = bitmap.height;
    drawSource = bitmap;
    closeSource = () => bitmap.close?.();
  } else {
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('이미지를 읽지 못했습니다'));
      image.src = url;
    }).finally(() => URL.revokeObjectURL(url));
    width = img.naturalWidth;
    height = img.naturalHeight;
    drawSource = img;
    closeSource = null;
  }

  if (!width || !height) throw new Error('이미지를 읽지 못했습니다');

  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(drawSource, 0, 0, canvas.width, canvas.height);
  closeSource?.();
  return canvas;
}

function createScaledOcrCanvas(sourceCanvas) {
  const longSide = Math.max(sourceCanvas.width, sourceCanvas.height);
  let scale = longSide < OCR_PREPROCESS_MIN_LONG_SIDE
    ? OCR_PREPROCESS_MIN_LONG_SIDE / longSide
    : 1;

  scale = Math.min(2.5, Math.max(1, scale));
  if (longSide * scale > OCR_PREPROCESS_MAX_SIDE) {
    scale = OCR_PREPROCESS_MAX_SIDE / longSide;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function getAutoLevelBounds(histogram, total) {
  const lowTarget = Math.max(1, Math.round(total * .01));
  const highTarget = Math.max(1, Math.round(total * .99));
  let sum = 0;
  let low = 0;
  let high = 255;

  for (let i = 0; i < histogram.length; i++) {
    sum += histogram[i];
    if (sum >= lowTarget) {
      low = i;
      break;
    }
  }

  sum = 0;
  for (let i = 0; i < histogram.length; i++) {
    sum += histogram[i];
    if (sum >= highTarget) {
      high = i;
      break;
    }
  }

  if (high <= low) high = Math.min(255, low + 1);
  return { low, high };
}

function createContrastOcrCanvas(sourceCanvas) {
  const canvas = createScaledOcrCanvas(sourceCanvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const histogram = new Uint32Array(256);

  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
    histogram[lum]++;
  }

  const { low, high } = getAutoLevelBounds(histogram, data.length / 4);
  const range = high - low || 1;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
    const leveled = Math.max(0, Math.min(255, Math.round((lum - low) * 255 / range)));
    data[i] = data[i + 1] = data[i + 2] = leveled;
    data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

function createInvertedContrastOcrCanvas(sourceCanvas) {
  const canvas = createScaledOcrCanvas(sourceCanvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const histogram = new Uint32Array(256);

  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
    histogram[lum]++;
  }

  const { low, high } = getAutoLevelBounds(histogram, data.length / 4);
  const range = high - low || 1;
  for (let i = 0; i < data.length; i += 4) {
    const lum = Math.round(data[i] * .299 + data[i + 1] * .587 + data[i + 2] * .114);
    const leveled = Math.max(0, Math.min(255, Math.round((lum - low) * 255 / range)));
    const inverted = 255 - leveled;
    data[i] = data[i + 1] = data[i + 2] = inverted;
    data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

function createAdaptiveOcrCanvas(sourceCanvas, mode = 'dark') {
  const brightText = mode === true || mode === 'bright';
  const mixedText = mode === 'mixed';
  const canvas = createScaledOcrCanvas(sourceCanvas);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = image;
  const stride = width + 1;
  const integral = new Uint32Array((width + 1) * (height + 1));
  const luma = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const dataIndex = (y * width + x) * 4;
      const lum = Math.round(data[dataIndex] * .299 + data[dataIndex + 1] * .587 + data[dataIndex + 2] * .114);
      const lumaIndex = y * width + x;
      luma[lumaIndex] = lum;
      rowSum += lum;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }

  const radius = Math.max(10, Math.round(Math.min(width, height) / 70));
  const thresholdOffset = brightText ? 12 : -9;
  const mixedOffset = 18;

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);
      const count = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum = integral[(y2 + 1) * stride + x2 + 1]
        - integral[y1 * stride + x2 + 1]
        - integral[(y2 + 1) * stride + x1]
        + integral[y1 * stride + x1];
      const mean = sum / count;
      const lum = luma[y * width + x];
      const isText = mixedText
        ? Math.abs(lum - mean) > mixedOffset
        : brightText
          ? lum > mean + thresholdOffset
          : lum < mean + thresholdOffset;
      const value = isText ? 0 : 255;
      const dataIndex = (y * width + x) * 4;
      data[dataIndex] = data[dataIndex + 1] = data[dataIndex + 2] = value;
      data[dataIndex + 3] = 255;
    }
  }

  removeBinaryGuideLines(data, width, height);
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function removeBinaryGuideLines(data, width, height) {
  const rowLimit = Math.round(width * .48);
  const colLimit = Math.round(height * .2);
  const rowsToClear = [];
  const colsToClear = [];

  for (let y = 0; y < height; y++) {
    let black = 0;
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4] < 128) black++;
    }
    if (black >= rowLimit) rowsToClear.push(y);
  }

  for (let x = 0; x < width; x++) {
    let black = 0;
    for (let y = 0; y < height; y++) {
      if (data[(y * width + x) * 4] < 128) black++;
    }
    if (black >= colLimit) colsToClear.push(x);
  }

  rowsToClear.forEach(y => {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4;
      data[index] = data[index + 1] = data[index + 2] = 255;
    }
  });

  colsToClear.forEach(x => {
    for (let y = 0; y < height; y++) {
      const index = (y * width + x) * 4;
      data[index] = data[index + 1] = data[index + 2] = 255;
    }
  });
}

function createOcrPreprocessVariants(sourceCanvas) {
  return [
    { label: '명암 보정', canvas: createContrastOcrCanvas(sourceCanvas), psm: '6' },
    { label: '반전 명암 보정', canvas: createInvertedContrastOcrCanvas(sourceCanvas), psm: '6' },
    { label: '일반 글자 보정', canvas: createAdaptiveOcrCanvas(sourceCanvas, 'dark'), psm: '6' },
    { label: '혼합 배경 보정', canvas: createAdaptiveOcrCanvas(sourceCanvas, 'mixed'), psm: '6' },
    { label: '밝은 글자 보정', canvas: createAdaptiveOcrCanvas(sourceCanvas, 'bright'), psm: '6' }
  ];
}

function detectOcrTextBands(sourceCanvas) {
  const { width, height } = sourceCanvas;
  if (height < 120) return [];

  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, width, height).data;
  const stepX = Math.max(2, Math.round(width / 420));
  const threshold = Math.max(7, Math.round((width / stepX) * .025));
  const activeRows = [];

  for (let y = 0; y < height; y += 2) {
    let activity = 0;
    for (let x = 0; x < width; x += stepX) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = r * .299 + g * .587 + b * .114;
      if ((max - min) > 28 || lum < 215) activity++;
    }
    if (activity >= threshold) activeRows.push(y);
  }

  const bands = [];
  let start = null;
  let prev = null;
  activeRows.forEach(y => {
    if (start == null) {
      start = y;
      prev = y;
      return;
    }
    if (y - prev <= 14) {
      prev = y;
      return;
    }
    bands.push({ y1: start, y2: prev });
    start = y;
    prev = y;
  });
  if (start != null) bands.push({ y1: start, y2: prev });

  return bands
    .map(band => ({
      y1: Math.max(0, band.y1 - 16),
      y2: Math.min(height, band.y2 + 18)
    }))
    .filter(band => band.y2 - band.y1 >= 22)
    .slice(0, OCR_MAX_ADDRESSES + 4);
}

function cropOcrBand(sourceCanvas, band) {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = Math.max(1, band.y2 - band.y1);
  canvas.getContext('2d').drawImage(
    sourceCanvas,
    0, band.y1, sourceCanvas.width, canvas.height,
    0, 0, sourceCanvas.width, canvas.height
  );
  return canvas;
}

function createOcrRecognitionJobs(sourceCanvas) {
  const jobs = createOcrPreprocessVariants(sourceCanvas);
  const bands = detectOcrTextBands(sourceCanvas);

  if (bands.length >= 2) {
    bands.forEach((band, i) => {
      const crop = cropOcrBand(sourceCanvas, band);
      jobs.push({ label: `행 ${i + 1} 명암 보정`, canvas: createContrastOcrCanvas(crop), psm: '7' });
      jobs.push({ label: `행 ${i + 1} 반전 보정`, canvas: createInvertedContrastOcrCanvas(crop), psm: '7' });
    });
  }

  return jobs;
}

const OCR_SIDO_SOURCE = '(?:서울(?:특별시|시)?|부산(?:광역시|시)?|대구(?:광역시|시)?|인천(?:광역시|시)?|광주(?:광역시|시)?|대전(?:광역시|시)?|울산(?:광역시|시)?|세종(?:특별자치시|시)?|경기(?:도)?|강원(?:특별자치도|도)?|충북|충청북도|충남|충청남도|전북|전라북도|전남|전라남도|경북|경상북도|경남|경상남도|제주(?:특별자치도|도)?)';
const OCR_SIGUNGU_SOURCE = '(?:[가-힣]{1,10}(?:시|군|구)(?:\\s+[가-힣]{1,10}구)?)';
const OCR_LEGAL_AREA_SOURCE = '(?:[가-힣][가-힣0-9]{0,12}(?:읍|면|동|리|가))';
const OCR_ROAD_NAME_SOURCE = '(?:[가-힣A-Za-z0-9.·ㆍ-]{1,30}(?:대로|번길|로|길|고속도로))';
const OCR_JIBUN_NUMBER_SOURCE = '(?:(?:산\\s*)?\\d{1,5}(?:\\s*-\\s*\\d{1,5})?)';
const OCR_ROAD_NUMBER_SOURCE = '(?:(?:지하\\s*)?\\d{1,5}(?:\\s*-\\s*\\d{1,5})?)';
const OCR_ADMIN_PREFIX_SOURCE = `(?:(?:${OCR_SIDO_SOURCE})\\s+)?(?:(?:${OCR_SIGUNGU_SOURCE})\\s+)?`;
const OCR_ADMIN_TOKEN_SOURCE = `${OCR_SIDO_SOURCE}|${OCR_SIGUNGU_SOURCE}`;

function normalizeOcrText(text = '') {
  return String(text)
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/[|＿_]/g, ' ')
    .replace(/[［\[{]/g, '(')
    .replace(/[］\]}]/g, ')')
    .replace(/[－–—―~〜∼]/g, '-')
    .replace(/(\d)\s*[一ー]\s*(\d)/g, '$1-$2')
    .replace(/민천(?=\s*(?:광역시|시|서구|남동구|미추홀구|부평구|계양구|연수구|중구|동구))/g, '인천')
    .replace(/가[자최]동(?=\s*(?:산\s*)?\d)/g, '가좌동')
    .replace(/보대동(?=\s*\d)/g, '복대동')
    .replace(/니동구(?=\s*부평동)/g, '부평구')
    .replace(/출라동(?=\s*\d)/g, '청라동')
    .replace(/[“”‘’"'`]/g, '')
    .replace(/\s*-\s*/g, '-')
    .replace(/([가-힣]{1,10}구)(?=[가-힣0-9]*(?:읍|면|동|리|가))/g, '$1 ')
    .replace(/([가-힣][가-힣0-9]*(?:읍|면|동|리|가))(?=(?:산\s*)?\d(?!\d*가))/g, '$1 ')
    .replace(/([가-힣A-Za-z0-9.·ㆍ-]+(?:대로|번길|로|길|고속도로))(?=(?:지하\s*)?\d)/g, '$1 ')
    .replace(/([가-힣]+동)(\d)\2가(?=\s*\d)/g, '$1$2가')
    .replace(/산\s*(?=\d)/g, '산 ')
    .replace(/산\s+(\d)\1(\d)\b/g, '산 $1-$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanOcrAddressLine(line) {
  return normalizeOcrText(line)
    .replace(/\b(?:T\.?|TEL|전화|연락처)\s*[:：]?\s*\d{2,4}[-.\s]\d{3,4}[-.\s]\d{4}.*$/i, '')
    .replace(/^\s*\(?우(?:편번호)?\)?\s*\d{3,5}(?:[-\s]\d{2,3})?\s*/i, '')
    .replace(/^\s*\(?\d{5}\)?\s+(?=[가-힣])/, '')
    .replace(/^\s*(?:[①-⑳]|[가-하]|\d{1,2})[\).:：-]\s*/, '')
    .replace(/^(출발지|도착지|출발|도착|경유지|목적지|방문지|주소지|주소|소재지|위치|도로명주소|지번주소|도로명|지번|장소|상호|업체명)\s*[:：-]?\s*/i, '')
    .replace(/\s*(전화|TEL|연락처|팩스|사업자|대표자).*$/i, '')
    .replace(/^[\s,.;:：/~-]+|[\s,.;:：/~-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAddressSignal(line) {
  const normalized = normalizeOcrText(line);
  const sido = new RegExp(OCR_SIDO_SOURCE);
  const sigungu = new RegExp(OCR_SIGUNGU_SOURCE);
  const legalArea = new RegExp(OCR_LEGAL_AREA_SOURCE);
  const roadName = new RegExp(OCR_ROAD_NAME_SOURCE);
  const roadWithNumber = new RegExp(`${OCR_ROAD_NAME_SOURCE}\\s*${OCR_ROAD_NUMBER_SOURCE}`);
  const jibunWithNumber = new RegExp(`${OCR_LEGAL_AREA_SOURCE}\\s*${OCR_JIBUN_NUMBER_SOURCE}`);
  const detail = /(아파트|빌딩|타워|센터|상가|오피스텔|회관|본관|별관|사옥|타운|프라자|몰|관|층|호|지하\s*\d?층?)/i;

  const hasSido = sido.test(normalized);
  const hasSigungu = sigungu.test(normalized);
  const hasLegalArea = legalArea.test(normalized);
  const hasRoadName = roadName.test(normalized);
  const hasRoadNumber = roadWithNumber.test(normalized);
  const hasJibun = jibunWithNumber.test(normalized);
  const hasDetail = detail.test(normalized);
  const hasAdministrative = hasSido || hasSigungu;
  const hasSpecific = hasRoadNumber || hasJibun;

  let score = 0;
  if (hasSido) score += 2;
  if (hasSigungu) score += 2;
  if (hasLegalArea) score += 1;
  if (hasRoadName) score += 1;
  if (hasRoadNumber) score += 5;
  if (hasJibun) score += 5;
  if (hasDetail) score += 1;

  return { score, hasAdministrative, hasLegalArea, hasRoadName, hasSpecific, hasSido, hasSigungu };
}

function isAdministrativeOnly(line) {
  if (/\d/.test(line)) return false;
  if (!/(특별시|광역시|특별자치시|특별자치도|[가-힣]+도|[가-힣]+시|[가-힣]+군|[가-힣]+구)/.test(line)) return false;
  const rest = line
    .replace(/(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|특별시|광역시|특별자치시|특별자치도|[가-힣]+도|[가-힣]+시|[가-힣]+군|[가-힣]+구|\s)/g, '');
  return rest.length === 0;
}

function isAddressFragment(line) {
  const signal = getAddressSignal(line);
  return signal.hasAdministrative
    || signal.hasLegalArea
    || signal.hasRoadName
    || /^(?:(?:산|지하)\s*)?\d{1,5}(?:-\d{1,5})?(?:\s|$)/.test(normalizeOcrText(line));
}

function isLikelyAddress(line) {
  const normalized = cleanOcrAddressLine(line);
  if (normalized.length < 2 || normalized.length > 90) return false;
  if (!/[가-힣]/.test(normalized)) return false;
  if (/(합계|소요|거리|검색|저장|초기화|도움말|설정|이미지|캡처|선택|확인|취소|추가|입력|전화|TEL|사업자|경로 계산|차도리|차량 운행|리포트|주소 입력|경유지 입력|사무실 주소|네이버지도|카카오맵|지도|공유|닫기|복사|거리뷰|위성|교통정보)/i.test(normalized)) return false;

  const signal = getAddressSignal(normalized);
  if (signal.hasSpecific && (signal.hasAdministrative || signal.score >= 5)) return true;
  if (signal.hasRoadName && !/\d/.test(normalized)) return false;
  if (isAdministrativeOnly(normalized)) return false;
  if (/\d/.test(normalized)) return signal.score >= 5;

  const hangulCount = (normalized.match(/[가-힣]/g) || []).length;
  const looksLikePlaceName = hangulCount >= 3
    && normalized.length <= 35
    && /^[가-힣A-Za-z0-9\s().&-]+$/.test(normalized)
    && !/(출발지|도착지|출발|도착|경유지|목적지|방문지|주소|위치)$/.test(normalized);

  return looksLikePlaceName;
}

function isStrictOcrAddress(line) {
  const normalized = cleanOcrAddressLine(line);
  if (!normalized || normalized.length > 70) return false;
  if (!/^[가-힣]/.test(normalized)) return false;
  if (/[A-Za-z]{2,}/.test(normalized)) return false;
  if (/[~<>_=+*#@$%^\\[\\]{}]/.test(normalized)) return false;
  if (!/^[가-힣0-9\s().,·ㆍ-]+$/.test(normalized)) return false;

  const signal = getAddressSignal(normalized);
  if (!signal.hasSpecific) return false;

  const firstSigungu = normalized.match(new RegExp(`^(${OCR_SIGUNGU_SOURCE})\\s+${OCR_LEGAL_AREA_SOURCE}`));
  if (!signal.hasSido && firstSigungu && firstSigungu[1].length > 4) return false;

  const lot = getAddressLotSignature(normalized);
  if (!signal.hasAdministrative && lot && lot.main.length < 2) return false;

  return true;
}

function getAdminMatches(text) {
  return Array.from(text.matchAll(new RegExp(OCR_ADMIN_TOKEN_SOURCE, 'g')))
    .map(match => ({
      text: match[0],
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      isSido: new RegExp(`^${OCR_SIDO_SOURCE}$`).test(match[0]),
      isSigungu: new RegExp(`^${OCR_SIGUNGU_SOURCE}$`).test(match[0])
    }));
}

function isCleanAddressGap(text) {
  const gap = normalizeOcrText(text)
    .replace(/^\s*(?:[①-⑳]|\d{1,2})[\).:：-]\s*/, '')
    .trim();
  return !gap || /^[\s,.;:：/()·ㆍ-]+$/.test(gap);
}

function getLegalAreaStem(line) {
  const match = normalizeOcrText(line).match(new RegExp(OCR_LEGAL_AREA_SOURCE));
  if (!match) return '';
  return match[0].replace(/(?:읍|면|동|리|가)$/, '').slice(0, 2);
}

function getAdminStem(line) {
  return normalizeOcrText(line).replace(/(?:시|군|구)$/, '').slice(0, 2);
}

function isLocalAdminForCore(admin, core) {
  const adminStem = getAdminStem(admin);
  const coreStem = getLegalAreaStem(core);
  return !!adminStem && !!coreStem && adminStem === coreStem;
}

function getCleanAdminPrefixBefore(text, coreIndex, core) {
  const start = Math.max(0, coreIndex - 44);
  const before = text.slice(start, coreIndex);
  const admins = getAdminMatches(before);
  if (!admins.length) return '';

  let chain = [];
  const lastSidoIndex = admins.map((admin, i) => admin.isSido ? i : -1).filter(i => i >= 0).pop();
  if (lastSidoIndex != null) {
    chain = [admins[lastSidoIndex]];
    for (let i = lastSidoIndex + 1; i < admins.length && chain.length < 3; i++) {
      const gap = before.slice(chain[chain.length - 1].end, admins[i].index);
      if (!isCleanAddressGap(gap)) break;
      if (!admins[i].isSigungu) break;
      chain.push(admins[i]);
    }
  } else {
    const last = admins[admins.length - 1];
    if (last.isSigungu && isLocalAdminForCore(last.text, core)) chain = [last];
  }

  if (!chain.length) return '';
  const trailingGap = before.slice(chain[chain.length - 1].end);
  if (!isCleanAddressGap(trailingGap)) return '';

  const prefix = cleanOcrAddressLine(chain.map(admin => admin.text).join(' '));
  return prefix.length <= 28 ? prefix : '';
}

function extractAddressCoreCandidates(line) {
  const normalized = cleanOcrAddressLine(line);
  if (!normalized) return [];

  const patterns = [
    new RegExp(`${OCR_LEGAL_AREA_SOURCE}\\s*${OCR_JIBUN_NUMBER_SOURCE}`, 'g'),
    new RegExp(`${OCR_ROAD_NAME_SOURCE}\\s*${OCR_ROAD_NUMBER_SOURCE}`, 'g')
  ];
  const matches = [];

  patterns.forEach(pattern => {
    for (const match of normalized.matchAll(pattern)) {
      const index = match.index ?? 0;
      const core = cleanOcrAddressLine(match[0]);
      const prefix = getCleanAdminPrefixBefore(normalized, index, core);
      const address = cleanOcrAddressLine(prefix ? `${prefix} ${core}` : core);
      if (!isStrictOcrAddress(address)) continue;
      matches.push({ index, address });
    }
  });

  return matches
    .sort((a, b) => a.index - b.index || b.address.length - a.address.length)
    .map(match => match.address);
}

function extractInlineAddressCandidates(line) {
  const normalized = cleanOcrAddressLine(line);
  if (!normalized) return [];

  const coreCandidates = extractAddressCoreCandidates(normalized);
  const patterns = [
    new RegExp(`${OCR_ADMIN_PREFIX_SOURCE}${OCR_LEGAL_AREA_SOURCE}\\s*${OCR_JIBUN_NUMBER_SOURCE}`, 'g'),
    new RegExp(`${OCR_ADMIN_PREFIX_SOURCE}${OCR_ROAD_NAME_SOURCE}\\s*${OCR_ROAD_NUMBER_SOURCE}`, 'g')
  ];
  const matches = coreCandidates.map((address, i) => ({ index: i, address }));

  patterns.forEach(pattern => {
    for (const match of normalized.matchAll(pattern)) {
      const candidate = cleanOcrAddressLine(match[0]);
      if (!isStrictOcrAddress(candidate)) continue;
      matches.push({ index: match.index ?? 0, address: candidate });
    }
  });

  return matches
    .sort((a, b) => a.index - b.index || b.address.length - a.address.length)
    .map(match => match.address);
}

function splitOcrAddressPieces(text) {
  return normalizeOcrText(text)
    .replace(/\r/g, '\n')
    .replace(/[•●○◯◎■□▶→▲△▼▽]/g, '\n')
    .replace(/(?:경유지|주소)\s*입력/gi, '\n')
    .replace(/(?:출발지|도착지|출발|도착|경유지|목적지|방문지|주소지|주소|소재지|위치|도로명주소|지번주소|도로명|지번)\s*[:：-]\s*/gi, '\n')
    .replace(/[;；]/g, '\n')
    .replace(/\s+[|｜]\s+/g, '\n')
    .split('\n')
    .map(cleanOcrAddressLine)
    .filter(Boolean);
}

function getAddressCoreKey(line) {
  const normalized = normalizeOcrText(line);
  const jibun = normalized.match(new RegExp(`(${OCR_LEGAL_AREA_SOURCE})\\s*((?:산\\s*)?\\d{1,5}(?:-\\d{1,5})?)`));
  if (jibun) return `jibun:${jibun[1]}:${jibun[2].replace(/\s+/g, '')}`;

  const road = normalized.match(new RegExp(`(${OCR_ROAD_NAME_SOURCE})\\s*((?:지하\\s*)?\\d{1,5}(?:-\\d{1,5})?)`));
  if (road) return `road:${road[1]}:${road[2].replace(/\s+/g, '')}`;

  return '';
}

function getAddressLotSignature(line) {
  const normalized = normalizeOcrText(line);
  const match = normalized.match(new RegExp(`(${OCR_LEGAL_AREA_SOURCE})\\s*(산\\s*)?(\\d{1,5})(?:-(\\d{1,5}))?`));
  if (!match) return null;
  return {
    area: match[1],
    isMountain: !!match[2],
    main: match[3],
    sub: match[4] || '',
    compact: `${match[3]}${match[4] || ''}`,
    hasHyphen: !!match[4]
  };
}

function isLooseLotDuplicate(a, b) {
  if (!a || !b) return false;
  if (a.area !== b.area || a.isMountain !== b.isMountain) return false;
  if (a.hasHyphen && b.hasHyphen) return a.compact === b.compact;
  if (a.hasHyphen && !b.hasHyphen) return b.compact.startsWith(a.main);
  if (!a.hasHyphen && b.hasHyphen) return a.compact.startsWith(b.main);
  return a.compact === b.compact;
}

function getAddressExactKey(line) {
  return normalizeOcrText(line).replace(/[^0-9가-힣]/g, '');
}

function isBetterAddressCandidate(next, current) {
  const nextLot = getAddressLotSignature(next);
  const currentLot = getAddressLotSignature(current);
  if (nextLot?.hasHyphen !== currentLot?.hasHyphen) return !!nextLot?.hasHyphen;

  const nextSignal = getAddressSignal(next);
  const currentSignal = getAddressSignal(current);
  if (nextSignal.score !== currentSignal.score) return nextSignal.score > currentSignal.score;
  if (nextSignal.hasAdministrative !== currentSignal.hasAdministrative) return nextSignal.hasAdministrative;
  return next.length > current.length;
}

function dedupeAddressCandidates(candidates, limit = OCR_MAX_ADDRESSES, strict = false) {
  const selected = [];
  const exactToIndex = new Map();
  const coreToIndex = new Map();
  const lotSignatures = [];

  candidates
    .map(cleanOcrAddressLine)
    .filter(candidate => strict ? isStrictOcrAddress(candidate) : isLikelyAddress(candidate))
    .forEach(candidate => {
      const exactKey = getAddressExactKey(candidate);
      const coreKey = getAddressCoreKey(candidate);
      const lotSignature = getAddressLotSignature(candidate);
      const duplicateIndex = exactToIndex.has(exactKey)
        ? exactToIndex.get(exactKey)
        : coreKey && coreToIndex.has(coreKey)
          ? coreToIndex.get(coreKey)
          : lotSignatures.findIndex(signature => isLooseLotDuplicate(lotSignature, signature));

      if (duplicateIndex >= 0) {
        if (isBetterAddressCandidate(candidate, selected[duplicateIndex])) {
          selected[duplicateIndex] = candidate;
          exactToIndex.set(exactKey, duplicateIndex);
          if (coreKey) coreToIndex.set(coreKey, duplicateIndex);
          lotSignatures[duplicateIndex] = lotSignature;
        }
        return;
      }

      if (selected.length >= limit) return;
      exactToIndex.set(exactKey, selected.length);
      if (coreKey) coreToIndex.set(coreKey, selected.length);
      lotSignatures.push(lotSignature);
      selected.push(candidate);
    });

  return selected;
}

function extractAddressCandidates(text) {
  const normalizedText = normalizeOcrText(text);
  const pieces = splitOcrAddressPieces(normalizedText);
  const candidates = extractInlineAddressCandidates(normalizedText);
  const mergePieces = [];

  pieces.forEach(piece => {
    const inlineCandidates = extractInlineAddressCandidates(piece);
    if (inlineCandidates.length > 1) {
      candidates.push(...inlineCandidates);
    } else {
      mergePieces.push(piece);
      candidates.push(inlineCandidates[0] || piece);
    }
  });

  for (let i = 0; i < mergePieces.length; i++) {
    let merged = null;
    for (let span = Math.min(3, mergePieces.length - i); span >= 2; span--) {
      const parts = mergePieces.slice(i, i + span);
      const combined = cleanOcrAddressLine(parts.join(' '));
      if (
        isLikelyAddress(combined)
        && !getAddressSignal(parts[0]).hasSpecific
        && !(span > 2 && getAddressSignal(parts[2]).hasAdministrative)
        && parts.every(isAddressFragment)
      ) {
        merged = { line: combined, span };
        break;
      }
    }

    if (merged) {
      candidates.push(merged.line);
      i += merged.span - 1;
    }
  }

  return dedupeAddressCandidates(candidates, OCR_MAX_ADDRESSES, true);
}

function renderOcrCandidates(candidates) {
  const list = document.getElementById('ocr-address-list');
  const empty = document.getElementById('ocr-empty');
  list.innerHTML = '';

  empty.style.display = candidates.length ? 'none' : '';
  document.getElementById('btn-apply-ocr-addresses').disabled = candidates.length === 0;

  candidates.forEach((address, i) => {
    const item = document.createElement('li');
    item.className = 'ocr-address-item';

    const num = document.createElement('span');
    num.className = 'ocr-address-num';
    num.textContent = i + 1;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ocr-address-input';
    input.value = address;
    input.addEventListener('input', updateOcrApplyState);

    item.append(num, input);
    list.appendChild(item);
  });
}

function openOcrImport() {
  resetOcrModal();
  setOcrStatus('캡처 이미지를 붙여넣으면 바로 주소를 인식합니다');
  openModal('modal-ocr');
  setTimeout(focusOcrDropZone, 0);
}

function focusOcrDropZone() {
  const zone = document.getElementById('ocr-drop-zone');
  zone?.focus();
  zone?.classList.add('paste-ready');
  setTimeout(() => zone?.classList.remove('paste-ready'), 700);
}

function getImageFromPaste(e) {
  const files = Array.from(e.clipboardData?.files || []);
  const imageFile = files.find(file => file.type.startsWith('image/'));
  if (imageFile) return imageFile;

  const items = Array.from(e.clipboardData?.items || []);
  const imageItem = items.find(item => item.type.startsWith('image/'));
  return imageItem?.getAsFile() || null;
}

async function recognizeOcrText(Tesseract, canvas) {
  const variants = createOcrRecognitionJobs(canvas);
  const texts = [];

  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    setOcrStatus(`${variant.label} 인식 중... (${i + 1}/${variants.length})`);

    const result = await Tesseract.recognize(variant.canvas, 'kor+eng', {
      preserve_interword_spaces: '1',
      tessedit_pageseg_mode: variant.psm,
      user_defined_dpi: '300',
      logger: msg => {
        if (typeof msg.progress === 'number') {
          setOcrProgress(.06 + ((i + msg.progress) / variants.length) * .9);
        }
      }
    });

    texts.push(result.data?.text || '');
  }

  return texts.join('\n');
}

async function processOcrImage(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    toast('이미지 파일만 사용할 수 있습니다', 3000);
    return;
  }

  S.ocrCandidates = [];
  document.getElementById('ocr-address-list').innerHTML = '';
  document.getElementById('ocr-empty').style.display = 'none';
  document.getElementById('btn-apply-ocr-addresses').disabled = true;
  showOcrPreview(file);
  setOcrProgress(.04);
  setOcrProcessing(true);

  try {
    const canvas = await imageFileToCanvas(file);
    setOcrStatus('OCR 준비 중...');
    const Tesseract = await loadTesseract();

    setOcrStatus('이미지 전처리 중...');
    setOcrProgress(.05);
    const recognizedText = await recognizeOcrText(Tesseract, canvas);
    const candidates = extractAddressCandidates(recognizedText);
    S.ocrCandidates = candidates;
    setOcrProgress(null);
    setOcrStatus(candidates.length ? `${candidates.length}개 주소 후보를 찾았습니다` : '주소 후보를 찾지 못했습니다');
    renderOcrCandidates(candidates);
  } catch (err) {
    setOcrProgress(null);
    console.error('OCR image import failed:', err);
    setOcrStatus('이미지 인식에 실패했습니다');
    toast(err?.message || '이미지 인식에 실패했습니다', 4000);
  } finally {
    setOcrProcessing(false);
  }
}

async function geocodeWaypointByIndex(i) {
  const wp = S.waypoints[i];
  if (!wp?.address) return false;

  const inputs = document.querySelectorAll('.wp-addr-input');
  const input = inputs[i];
  if (input) {
    input.classList.add('geocoding');
    input.classList.remove('error');
  }

  const address = wp.address;
  try {
    const result = await geocodeByRest(address);
    if (!S.waypoints[i] || S.waypoints[i].address !== address) return false;

    if (result) {
      S.waypoints[i].x = result.x;
      S.waypoints[i].y = result.y;
      if (input) {
        input.classList.add('filled');
        input.classList.remove('error');
      }
      return true;
    }

    S.waypoints[i].x = '';
    S.waypoints[i].y = '';
    if (input) input.classList.add('error');
    return false;
  } finally {
    if (input) input.classList.remove('geocoding');
  }
}

async function applyOcrAddresses() {
  const addresses = dedupeAddressCandidates(Array.from(document.querySelectorAll('.ocr-address-input'))
    .map(input => input.value.trim())
    .filter(Boolean));

  if (!addresses.length) {
    toast('적용할 주소가 없습니다');
    return;
  }

  const count = addresses.length;
  S.waypoints = Array.from({ length: Math.max(5, count) }, createWaypoint);
  addresses.forEach((address, i) => {
    S.waypoints[i].address = address;
  });

  renderWaypoints();
  closeModal('modal-ocr');
  toast(`${count}개 주소를 입력했습니다. 좌표 확인 중...`, 2500);

  const geocodeResults = await Promise.all(addresses.map((_, i) => geocodeWaypointByIndex(i)));
  const successCount = geocodeResults.filter(Boolean).length;
  toast(
    successCount === count
      ? `${count}개 주소 입력 완료`
      : `${successCount}/${count}개 주소 좌표를 확인했습니다`,
    3500
  );
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

  // 에러 발생한 첫 번째 경유지 찾기
  const errorIndex = filledWps.findIndex(p => !p.x || !p.y);
  if (errorIndex !== -1) {
    const errorWp = filledWps[errorIndex];
    const inputs = document.querySelectorAll('.wp-addr-input');
    // 실제 전체 waypoints 배열에서의 인덱스를 찾아야 함 (filledWps의 인덱스가 아님)
    const realIdx = S.waypoints.findIndex(p => p.id === errorWp.id);

    if (inputs[realIdx]) {
      inputs[realIdx].classList.add('error');
      inputs[realIdx].focus();
    }
    toast(`'${errorWp.address}'의 좌표를 찾지 못했습니다. 목록에서 확인해주세요.`, 4000);
    return;
  }

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
    distance: Math.round(sec.distance / 100) / 10, // m → km (1 decimal)
    duration: sec.duration || 0 // 초 단위
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
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

function renderResults() {
  const tbody = document.getElementById('segments-body');
  tbody.innerHTML = '';
  let totalDuration = 0;
  S.segments.forEach((seg, i) => {
    totalDuration += seg.duration || 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${seg.from}">${seg.from}</td>
      <td style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${seg.to}">${seg.to}</td>
      <td><strong>${seg.distance.toFixed(1)}</strong></td>
      <td>${formatDuration(seg.duration || 0)}</td>
      <td><button class="copy-seg-btn" data-i="${i}" title="도착지명 복사">복사</button></td>
    `;
    tbody.appendChild(tr);
  });
  const totalText = S.totalDist.toFixed(1) + ' km';
  document.getElementById('total-km').textContent = totalText;
  const foot = document.getElementById('total-km-foot');
  if (foot) foot.textContent = totalText;
  const footDur = document.getElementById('total-dur-foot');
  if (footDur) footDur.textContent = formatDuration(totalDuration);

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
  toast('주소가 복사되었습니다');
  // Visual feedback on button
  const btns = document.querySelectorAll('.wp-btn.cp');
  if (btns[idx]) {
    btns[idx].textContent = '완료';
    setTimeout(() => { btns[idx].textContent = '복사'; }, 1500);
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
  btn.textContent = '완료';
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = '복사'; btn.classList.remove('copied'); }, 1500);
  toast(`복사됨: ${seg.to}`);
});


// ============================================================
// SAVED ROUTES (최대 3건)
// ============================================================
function saveRoute() {
  if (!S.segments.length) { toast('먼저 경로를 계산해주세요'); return; }

  // 전체 경로 라벨 생성 (출발지 → 경유지1 → 경유지2 → ... → 도착지)
  const stops = [S.segments[0]?.from];
  S.segments.forEach(seg => stops.push(seg.to));
  // 연속 중복 제거 (사무실→사무실 같은 경우 방지)
  const uniqueStops = stops.filter((s, i) => i === 0 || s !== stops[i - 1]);
  const label = uniqueStops.join(' → ');
  const totalDuration = S.segments.reduce((sum, seg) => sum + (seg.duration || 0), 0);

  const record = {
    id: genId(),
    date: new Date().toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }),
    label,
    totalDist: S.totalDist,
    totalDuration,
    waypoints: S.waypoints.map(w => ({ ...w })),
    segments: S.segments.map(s => ({ ...s })),
    fixOffice: S.settings.fixOffice,
    officeAddr: S.settings.officeAddr,
    officeX: S.settings.officeX,
    officeY: S.settings.officeY
  };

  S.savedRoutes.unshift(record);
  // 최대 3건 유지
  if (S.savedRoutes.length > 3) S.savedRoutes = S.savedRoutes.slice(0, 3);
  save('drvlog_saved_routes', S.savedRoutes);
  renderSavedRoutes();
  toast('경로가 저장되었습니다');
}

function renderSavedRoutes() {
  const section = document.getElementById('saved-routes-section');
  const list = document.getElementById('saved-routes-list');
  const countEl = document.getElementById('saved-routes-count');

  if (!S.savedRoutes.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  countEl.textContent = `${S.savedRoutes.length}/3`;
  list.innerHTML = '';

  S.savedRoutes.forEach((route, idx) => {
    const item = document.createElement('div');
    item.className = 'saved-route-item';
    item.innerHTML = `
      <div class="saved-route-content">
        <div class="saved-route-label" title="${route.label}">${route.label}</div>
        <div class="saved-route-meta">
          <span>${route.totalDist?.toFixed(1)} km</span>
          <span>·</span>
          <span>${formatDuration(route.totalDuration || 0)}</span>
          <span>·</span>
          <span>${route.date}</span>
        </div>
      </div>
      <button class="saved-route-del" data-idx="${idx}" title="삭제">✕</button>
    `;
    // 카드 클릭 → 불러오기
    item.querySelector('.saved-route-content').addEventListener('click', () => loadSavedRoute(idx));
    // 삭제 버튼
    item.querySelector('.saved-route-del').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSavedRoute(idx);
    });
    list.appendChild(item);
  });
}

async function loadSavedRoute(idx) {
  const route = S.savedRoutes[idx];
  if (!route) return;

  // 경유지 복원
  S.waypoints = route.waypoints.map(w => ({ ...w }));
  renderWaypoints();

  // 자동 경로 계산 실행
  toast('경로를 불러오는 중...', 1500);
  await calcRoute();
}

function deleteSavedRoute(idx) {
  S.savedRoutes.splice(idx, 1);
  save('drvlog_saved_routes', S.savedRoutes);
  renderSavedRoutes();
  toast('저장된 경로가 삭제되었습니다');
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
  document.getElementById('set-weather-enabled').checked = !!st.weatherEnabled;
  document.getElementById('set-default-region').value = st.defaultRegion || '';
  updateOfficeAddressPicker(st.officeAddr || '');
  openModal('modal-settings');
}

async function saveSettings() {
  const officeAddr = document.getElementById('set-office-addr').value.trim();
  const officeX = document.getElementById('set-office-x').value;
  const officeY = document.getElementById('set-office-y').value;
  const fixOffice = document.getElementById('set-fix-office').checked;
  const weatherEnabled = document.getElementById('set-weather-enabled').checked;
  const defaultRegion = document.getElementById('set-default-region').value;

  if (fixOffice && !officeAddr) {
    toast('사무실 주소를 먼저 선택해주세요');
    document.getElementById('btn-search-office').classList.add('needs-attention');
    return;
  }

  if (weatherEnabled && (!officeAddr || !officeX || !officeY)) {
    toast('날씨 표시는 사무실 주소 좌표가 필요합니다');
    document.getElementById('btn-search-office').classList.add('needs-attention');
    return;
  }

  // API 키는 코드에 고정된 상수 사용
  S.settings = { jsKey: KAKAO_JS_KEY, restKey: KAKAO_REST_KEY, officeAddr, officeX, officeY, fixOffice, defaultRegion, weatherEnabled };
  save('drvlog_settings', S.settings);

  updateFixedStops();
  updateHeaderWeather();
  closeModal('modal-settings');
  toast('설정이 저장되었습니다');
}

function updateOfficeAddressPicker(address) {
  const picker = document.getElementById('btn-search-office');
  const valueEl = document.getElementById('office-picker-value');
  if (!picker || !valueEl) return;

  const hasAddress = !!address;
  picker.classList.toggle('has-address', hasAddress);
  picker.classList.remove('needs-attention');
  valueEl.textContent = hasAddress ? address : '주소를 검색해서 선택하세요';
  valueEl.title = address || '';
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
  document.getElementById('btn-search-office').classList.remove('needs-attention');
  await loadDaumPostcode();
  new daum.Postcode({
    async oncomplete(data) {
      const addr = data.roadAddress || data.jibunAddress;
      document.getElementById('set-office-addr').value = addr;
      updateOfficeAddressPicker(addr);
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
        toast('사무실 주소 좌표 설정 완료');
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
document.getElementById('btn-help').addEventListener('click', () => openModal('modal-help'));
document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
document.getElementById('btn-add-wp').addEventListener('click', addWp);
document.getElementById('btn-ocr-capture').addEventListener('click', openOcrImport);
document.getElementById('ocr-drop-zone').addEventListener('click', e => {
  if (e.target.closest('button')) return;
  focusOcrDropZone();
  setOcrStatus('캡처한 이미지를 이 창에서 Ctrl+V 또는 ⌘V로 붙여넣어 주세요');
});
document.getElementById('ocr-drop-zone').addEventListener('keydown', e => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  focusOcrDropZone();
  setOcrStatus('캡처한 이미지를 이 창에서 Ctrl+V 또는 ⌘V로 붙여넣어 주세요');
});
document.addEventListener('paste', e => {
  if (!document.getElementById('modal-ocr').classList.contains('open')) return;
  const file = getImageFromPaste(e);
  e.preventDefault();
  if (!file) {
    focusOcrDropZone();
    setOcrStatus('클립보드에서 이미지를 찾지 못했습니다');
    toast('캡처 이미지를 복사한 뒤 Ctrl+V 또는 ⌘V로 붙여넣어 주세요', 3500);
    return;
  }
  processOcrImage(file);
});
document.getElementById('btn-apply-ocr-addresses').addEventListener('click', applyOcrAddresses);
document.getElementById('btn-reset').addEventListener('click', () => {
  if (confirm('경유지를 초기화하시겠습니까?')) resetWaypoints();
});
document.getElementById('btn-calc').addEventListener('click', calcRoute);
document.getElementById('btn-save-route').addEventListener('click', saveRoute);
document.getElementById('btn-reset-settings').addEventListener('click', () => {
  if (confirm('모든 설정을 초기화하시겠습니까? (사무실 주소 및 기본 지역 필터 등)')) {
    localStorage.removeItem('drvlog_settings');
    S.settings = {
      jsKey: KAKAO_JS_KEY, restKey: KAKAO_REST_KEY,
      officeAddr: '', officeX: '', officeY: '',
      fixOffice: true, driver: '', vehicle: '',
      defaultRegion: '',
      weatherEnabled: false
    };
    openSettings(); // UI 갱신을 위해 다시 열기
    updateFixedStops();
    updateHeaderWeather();
    toast('설정이 초기화되었습니다');
  }
});

// 모달 외부 클릭 및 닫기 버튼 범용 처리 (동적 추가 대응)
document.addEventListener('click', e => {
  const closeBtn = e.target.closest('.modal-close');
  if (closeBtn && closeBtn.dataset.close) {
    closeModal(closeBtn.dataset.close);
    return;
  }
  const modalBtn = e.target.closest('[data-close]');
  if (modalBtn && modalBtn.classList.contains('btn-primary') && modalBtn.dataset.close === 'modal-help') {
    closeModal('modal-help');
    return;
  }
});


// ============================================================
// INIT
// ============================================================
async function init() {
  loadAll();
  updateFixedStops();
  updateHeaderWeather();
  renderSavedRoutes();
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
    setTimeout(() => { toast('설정에서 사무실 주소를 입력해주세요', 4000); }, 600);
    openSettings();
  }
}

init();
