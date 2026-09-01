/* 앱 상태와 무관한 순수 도구 모음.
 *   TV.tone      번역기 말투 변환
 *   TV.cal       2027 캘린더 계산
 *   TV.map       세계지도 투영 · 경로
 *   TV.fmt       표시 포맷
 */
window.TV = (function () {
"use strict";

/* ============================================================
   번역기 말투 변환 — 서버도 API 키도 없이 브라우저에서 바로 돕니다.
   문법 교정기가 아니라 "말투 지문 지우기"가 목적입니다. 결정적이라
   누가 써도 같은 문체로 수렴하고, 그게 익명성에 도움이 됩니다.
   ============================================================ */
function cleanTone(s) {
  return String(s || "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu, " ")
    .replace(/[ㄱ-ㅎㅏ-ㅣ]+/g, " ")
    .replace(/~+/g, "")
    .replace(/([!?.,])\1+/g, "$1")
    .replace(/!/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

var LEXICON = [
  [/존맛탱|존맛|JMT|jmt/gi, "매우 맛있음"],
  [/(?:개꿀|꿀잼|존잼|짱잼)(?:임|이야|이다)?/g, "매우 만족스러움"],
  [/노잼/g, "재미없음"],
  [/미쳤음|미쳤다|미쳤어|미침|쩐다|쩔어|지린다|지림/g, "훌륭함"],
  [/짱이야|짱임|짱이다/g, "훌륭함"],
  [/개편함|개편해/g, "매우 편리함"],
  [/개좋아함|개좋음|개좋아/g, "매우 좋음"],
  [/개싸다|개쌈|개싸/g, "매우 저렴함"],
  [/개비싸다|개비쌈/g, "매우 비쌈"],
  [/개멀다|개멂|개멀음/g, "매우 멂"],
  [/강추/g, "적극 추천함"],
  [/비추/g, "추천하지 않음"],
  [/갬성/g, "감성"],
  [/가성비/g, "가격 대비 만족도"],
  [/인생샷/g, "인상적인 사진"],
  [/핫플/g, "인기 있는 장소"],
  [/맛집/g, "좋은 음식점"],
  [/보고싶/g, "보고 싶"],
  [/가고싶/g, "가고 싶"],
  [/개(?=[가-힣])/g, "매우 "],
  [/졸라|존나|겁나|엄청|되게/g, "매우"],
  [/짱/g, "매우"],
  [/(^|\s)나는(?=\s|$)/g, "$1저는"],
  [/(^|\s)내가(?=\s|$)/g, "$1제가"],
  [/(^|\s)나도(?=\s|$)/g, "$1저도"],
  [/(^|\s)나(?=\s)/g, "$1저"],
  [/진짜|레알/g, "정말"],
  [/걍/g, "그냥"],
  [/넘(?=\s)/g, "너무"],
  [/젤(?=\s)/g, "가장"],
];

var NOT_ENDING = /^(다음|처음|마음|얼음|죽음|웃음|울음|걸음|게임|모임|소음|이음|봄|밤|담|샴|팀|셈|점|힘|참)$/;

var ENDINGS = [
  [/있(어요|어|다|음|네요|네|지|거든요|거든|잖아요|잖아|더라)$/, "있습니다"],
  [/없(어요|어|다|음|네요|네|지|거든요|거든|잖아요|잖아|더라)$/, "없습니다"],
  [/좋(아요|아|다|음|네요|네|지|거든요|거든|잖아요|잖아|더라)$/, "좋습니다"],
  [/싫(어요|어|다|음|네요|네|더라)$/, "별로입니다"],
  [/싶(어요|어|다|음|네요|네|어라)$/, "싶습니다"],
  [/같(아요|아|다|음|네요|네|더라)$/, "같습니다"],
  [/많(아요|아|다|음|네요|네|더라)$/, "많습니다"],
  [/맛있(어요|어|다|음|네요|네|더라)$/, "맛있습니다"],
  [/재밌(어요|어|다|음|네요|네)$|재미있(어요|어|다|음)$/, "흥미롭습니다"],
  [/비싸(요|다|지|네요|네)$|비쌈$/, "비쌉니다"],
  [/싸(요|다|지|네요|네)$|쌈$/, "저렴합니다"],
  [/멀(어요|어|다|네요|네|음)$|멂$/, "멉니다"],
  [/가까(워요|워|움|웠어)$|가깝(다|네요|네)$/, "가깝습니다"],
  [/예뻐요$|예뻐$|예쁨$|예쁘다$|이쁨$|이쁘다$|이뻐$/, "아름답습니다"],
  [/(?:하고\s*)?싶(어요|어|음|다)$/, "하고 싶습니다"],
  [/(?:들|하)?자$/, "하고 싶습니다"],
  [/(?:않나|않냐|아닌가|아냐)\??$/, "않은지 궁금합니다"],
  [/듦$|듬$/, "듭니다"],
  [/(.+?)(?:ㄹ|을|일)\s*듯$/, "$1을 것 같습니다"],
  [/(.+?)\s*듯$/, "$1 것 같습니다"],
  [/스러움$/, "스럽습니다"],
  [/러움$|로움$/, "롭습니다"],
  [/(.+?)(?:거야|거지|거임|건데)$/, "$1것입니다"],
  [/(.+?)(?:인듯|인 듯)$/, "$1인 것 같습니다"],
  [/(.+?)(?:이에요|예요|이야|이다)$/, "$1입니다"],
  [/(.+?)됨$/, "$1됩니다"],
  [/(.+?)함$/, "$1합니다"],
  [/(.+?)임$/, "$1입니다"],
  [/(.+?)(?:해요|해)$/, "$1합니다"],
  [/(.+?)(?:어요|아요)$/, "$1습니다"],
  [/(.+?)음$/, "$1습니다"],
];

function formalize(clause) {
  var s = clause.trim().replace(/[.?!,]+$/, "").trim();
  if (!s) return "";
  for (var i = 0; i < ENDINGS.length; i++) {
    if (ENDINGS[i][0].test(s)) return s.replace(ENDINGS[i][0], ENDINGS[i][1]) + ".";
  }
  return s + ".";
}

function translatorize(raw) {
  var s = cleanTone(raw);
  LEXICON.forEach(function (r) { s = s.replace(r[0], r[1]); });
  s = s.replace(/([가-힣]{0,6}[음함임됨듦])\s+(?=[가-힣])/g, function (m, w) {
    return NOT_ENDING.test(w) ? m : w + ". ";
  });
  return s.split(/(?<=[.?])\s*/)
    .filter(function (p) { return p.trim(); })
    .map(formalize).filter(Boolean).join(" ")
    .replace(/\s+/g, " ").replace(/\s+\./g, ".").trim();
}

/* ============================================================
   캘린더 (2027)
   ============================================================ */
var YEAR = 2027;
var WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function iso(y, m, d) {
  return y + "-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;
}
function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); }
function firstWeekday(y, m) { return new Date(y, m - 1, 1).getDay(); }

/** 2027년 12개월치 구조. 각 달은 { m, label, lead, days:[iso...] } */
function months() {
  var out = [];
  for (var m = 1; m <= 12; m++) {
    var n = daysInMonth(YEAR, m), days = [];
    for (var d = 1; d <= n; d++) days.push(iso(YEAR, m, d));
    out.push({ m: m, label: YEAR + "." + (m < 10 ? "0" : "") + m, lead: firstWeekday(YEAR, m), days: days });
  }
  return out;
}

/** 두 날짜 사이(포함)의 모든 ISO 날짜 */
function range(a, b) {
  if (a > b) { var t = a; a = b; b = t; }
  var out = [], cur = new Date(a + "T00:00:00"), end = new Date(b + "T00:00:00");
  while (cur <= end) {
    out.push(iso(cur.getFullYear(), cur.getMonth() + 1, cur.getDate()));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

/** "2027-03-14" -> "3월 14일 (일)" */
function pretty(d) {
  var p = d.split("-"), dt = new Date(d + "T00:00:00");
  return Number(p[1]) + "월 " + Number(p[2]) + "일 (" + WEEKDAYS[dt.getDay()] + ")";
}

/** 연속된 날짜를 묶어 "3월 14~17일" 식으로 압축 */
function summarize(list) {
  if (!list.length) return "";
  var s = list.slice().sort(), runs = [], start = s[0], prev = s[0];
  for (var i = 1; i <= s.length; i++) {
    var next = s[i];
    var expect = next && range(prev, next).length === 2;
    if (!expect) { runs.push([start, prev]); start = next; }
    prev = next;
  }
  return runs.map(function (r) {
    var a = r[0].split("-"), b = r[1].split("-");
    if (r[0] === r[1]) return Number(a[1]) + "/" + Number(a[2]);
    if (a[1] === b[1]) return Number(a[1]) + "/" + Number(a[2]) + "~" + Number(b[2]);
    return Number(a[1]) + "/" + Number(a[2]) + "~" + Number(b[1]) + "/" + Number(b[2]);
  }).join(", ");
}

/* ============================================================
   세계지도 — 등장방형 도법. 남극은 잘라내 모바일 비율에 맞춥니다.
   viewBox: 0 0 360 144  (경도 -180~180, 위도 84~-60)
   ============================================================ */
var LAT_TOP = 84, LAT_BOTTOM = -60;
var MAP_W = 360, MAP_H = 144;

function px(lon) { return (lon + 180) / 360 * MAP_W; }
function py(lat) {
  var t = Math.max(LAT_BOTTOM, Math.min(LAT_TOP, lat));
  return (LAT_TOP - t) / (LAT_TOP - LAT_BOTTOM) * MAP_H;
}

/** 나라별 SVG path d 문자열. { ISO: "M..." } */
var _paths = null;
function countryPaths() {
  if (_paths) return _paths;
  _paths = {};
  var world = window.WORLD || [];
  for (var i = 0; i < world.length; i++) {
    var iso2 = world[i][0], rings = world[i][1], d = "";
    for (var j = 0; j < rings.length; j++) {
      var rg = rings[j];
      for (var k = 0; k < rg.length; k++) {
        d += (k ? "L" : "M") + px(rg[k][0]).toFixed(1) + "," + py(rg[k][1]).toFixed(1);
      }
      d += "Z";
    }
    _paths[iso2] = d;
  }
  return _paths;
}

/** 두 지점 사이 대권 경로를 폴리라인 조각들로. 날짜변경선을 넘으면 끊어 줍니다. */
function arc(a, b, steps) {
  steps = steps || 48;
  var toR = Math.PI / 180;
  var v = function (p) {
    var la = p.lat * toR, lo = p.lon * toR;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  var A = v(a), B = v(b);
  var dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  var w = Math.acos(dot);
  if (!w) return [];
  var segs = [], cur = [], prevLon = null;
  for (var i = 0; i <= steps; i++) {
    var t = i / steps;
    var s1 = Math.sin((1 - t) * w) / Math.sin(w), s2 = Math.sin(t * w) / Math.sin(w);
    var x = s1 * A[0] + s2 * B[0], y = s1 * A[1] + s2 * B[1], z = s1 * A[2] + s2 * B[2];
    var lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / toR;
    var lon = Math.atan2(y, x) / toR;
    if (prevLon !== null && Math.abs(lon - prevLon) > 180) { segs.push(cur); cur = []; }
    cur.push([px(lon), py(lat)]);
    prevLon = lon;
  }
  if (cur.length > 1) segs.push(cur);
  return segs.filter(function (s) { return s.length > 1; }).map(function (s) {
    return s.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1); }).join("");
  });
}

/* ============================================================
   표시 포맷
   ============================================================ */
function hours(h) {
  var H = Math.floor(h), M = Math.round((h - H) * 60);
  return M ? H + "시간 " + M + "분" : H + "시간";
}
function won(p) { return p[0] + "~" + p[1] + "만원"; }

return {
  tone: { translatorize: translatorize },
  cal: { YEAR: YEAR, WEEKDAYS: WEEKDAYS, months: months, range: range, pretty: pretty, summarize: summarize, iso: iso },
  map: { W: MAP_W, H: MAP_H, px: px, py: py, countryPaths: countryPaths, arc: arc },
  fmt: { hours: hours, won: won }
};
})();
