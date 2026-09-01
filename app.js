/* 여행지 소거전 — 클라이언트
 *
 * 저장소는 두 갈래입니다.
 *   shared : Supabase (여러 폰에서 링크로 접속, 실시간 동기화)
 *   local  : config.js 가 비어 있거나 접속이 안 될 때. 한 기기에서 폰을 돌려가며 사용.
 *
 * 코멘트는 브라우저에서 규칙 기반으로 "번역기 말투"로 변환됩니다. 서버도 API 키도 쓰지 않습니다.
 */
(function () {
"use strict";

/* ============================================================
   0. helpers
   ============================================================ */
var $ = function (s) { return document.querySelector(s); };

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function uid() { return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6); }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function shuffle(a) {
  var r = a.slice();
  for (var i = r.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = r[i]; r[i] = r[j]; r[j] = t; }
  return r;
}
function chars(s) { return Array.from(String(s || "")).length; }

var LS = {
  get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
};

var COMMENT_MAX = 100;   // 원문·변환문 모두 100자
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  var out = "";
  for (var i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

/* ============================================================
   1. config / supabase
   ============================================================ */
var CFG = window.TRIP_VOTE_CONFIG || {};
var CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY &&
                    CFG.SUPABASE_URL.indexOf("YOUR-") < 0 && CFG.SUPABASE_ANON_KEY.indexOf("YOUR-") < 0);

var sb = null;          // 방 코드 헤더가 붙은 클라이언트
var authClient = null;  // 로그인 전용
var session = null;

function baseClient(headers) {
  return window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
    global: headers ? { headers: headers } : undefined
  });
}

async function ensureSession() {
  authClient = authClient || baseClient(null);
  var got = await authClient.auth.getSession();
  session = got.data.session;
  if (!session) {
    var res = await authClient.auth.signInAnonymously();
    if (res.error) throw res.error;
    session = res.data.session;
  }
  return session;
}

/* ============================================================
   2. state
   ============================================================ */
var DEFAULT_META = {
  phase: "lobby", round: 1, candidates: [], finalists: [],
  tiebreak: null, winner: null, spin: null
};

var S = { meta: null, places: [], voters: [], ballots: [] };
var mode = "connecting";     // connecting | shared | local
var roomId = null, roomCode = null;
var bootError = "";

var me = { id: LS.get("tv_cid") || "", name: LS.get("tv_name") || "" };
function ensureCid() { if (!me.id) { me.id = uid(); LS.set("tv_cid", me.id); } return me.id; }

var draft = null;
var modalView = null;
var toast = "";
var spinSeen = {};
var wheelBusy = false;

function M() { return S.meta || DEFAULT_META; }
function votesFor(round) { return round === 1 ? 2 : 1; }
function placeById(id) { for (var i = 0; i < S.places.length; i++) if (S.places[i].id === id) return S.places[i]; return null; }
function placeName(id) { var p = placeById(id); return p ? p.name : "(삭제된 여행지)"; }
function candidateIds() {
  var m = M();
  if (m.phase === "lobby") return S.places.map(function (p) { return p.id; });
  var c = m.candidates || [];
  return c.length ? c.filter(function (id) { return !!placeById(id); }) : S.places.map(function (p) { return p.id; });
}
function myVoter() { for (var i = 0; i < S.voters.length; i++) if (S.voters[i].client_id === me.id) return S.voters[i]; return null; }
function hasVoted(v, round) { return !!(v && v.rounds && v.rounds["r" + round]); }
function votedCount(round) { var n = 0; S.voters.forEach(function (v) { if (hasVoted(v, round)) n++; }); return n; }

/* ============================================================
   3. store
   ============================================================ */
var LKEY = "tv_local_room_v2";

function localLoad() {
  try {
    var raw = LS.get(LKEY);
    if (raw) { var o = JSON.parse(raw); S.meta = o.meta || null; S.places = o.places || []; S.voters = o.voters || []; S.ballots = o.ballots || []; }
  } catch (e) {}
}
function localSave() {
  try { LS.set(LKEY, JSON.stringify({ meta: S.meta, places: S.places, voters: S.voters, ballots: S.ballots })); } catch (e) {}
}

async function fetchRoom() {
  var r = await sb.from("rooms").select("*").eq("id", roomId).maybeSingle();
  if (r.data) {
    S.meta = r.data;
    if (r.data.phase === "result" || r.data.phase === "done") await fetchBallots();
  }
  schedule();
}
async function fetchPlaces() {
  var r = await sb.from("places").select("*").eq("room_id", roomId).order("sort", { ascending: true });
  S.places = r.data || [];
  schedule();
}
async function fetchVoters() {
  var r = await sb.from("voters").select("*").eq("room_id", roomId).order("joined_at", { ascending: true });
  S.voters = r.data || [];
  schedule();
}
async function fetchBallots() {
  var r = await sb.from("ballots").select("*").eq("room_id", roomId).order("id", { ascending: true });
  S.ballots = r.data || [];
  schedule();
}

var store = {
  setMeta: async function (patch) {
    if (mode === "shared") {
      var r = await sb.from("rooms").update(patch).eq("id", roomId);
      if (r.error) { say(writeError(r.error)); return; }
      await fetchRoom();
    } else {
      S.meta = Object.assign({}, M(), patch); localSave(); schedule();
    }
  },
  addPlace: async function (d) {
    if (mode === "shared") {
      var r = await sb.from("places").insert({ room_id: roomId, name: d.name, note: d.note, added_by: d.added_by, sort: d.sort });
      if (r.error) { say(writeError(r.error)); return; }
      await fetchPlaces();
    } else { S.places.push(Object.assign({ id: uid() }, d)); localSave(); schedule(); }
  },
  delPlace: async function (id) {
    if (mode === "shared") { await sb.from("places").delete().eq("id", id); await fetchPlaces(); }
    else { S.places = S.places.filter(function (p) { return p.id !== id; }); localSave(); schedule(); }
  },
  setVoter: async function (v) {
    if (mode === "shared") {
      var r = await sb.from("voters")
        .upsert({ room_id: roomId, client_id: v.client_id, name: v.name, rounds: v.rounds }, { onConflict: "room_id,client_id" });
      if (r.error) { say(writeError(r.error)); return; }
      await fetchVoters();
    } else {
      var found = false;
      S.voters = S.voters.map(function (x) { if (x.client_id === v.client_id) { found = true; return v; } return x; });
      if (!found) S.voters.push(v);
      localSave(); schedule();
    }
  },
  addBallot: async function (b) {
    if (mode === "shared") {
      var r = await sb.from("ballots").insert({ room_id: roomId, round: b.round, entries: b.entries });
      if (r.error) { say(writeError(r.error)); return false; }
      return true;
    }
    S.ballots.push(Object.assign({ id: uid() }, b)); localSave(); schedule(); return true;
  },
  resetAll: async function () {
    if (mode === "shared") {
      await sb.from("ballots").delete().eq("room_id", roomId);
      await sb.from("voters").delete().eq("room_id", roomId);
      await sb.from("places").delete().eq("room_id", roomId);
      await sb.from("rooms").update({ phase: "lobby", round: 1, candidates: [], finalists: [], tiebreak: null, winner: null, spin: null }).eq("id", roomId);
      S.ballots = []; await fetchPlaces(); await fetchVoters(); await fetchRoom();
    } else {
      S = { meta: Object.assign({}, DEFAULT_META), places: [], voters: [], ballots: [] };
      localSave(); schedule();
    }
  }
};

function writeError(err) {
  // RLS 위반은 "행을 못 찾음"처럼 보입니다. 방 코드 헤더가 빠졌을 때가 대부분입니다.
  if (err && (err.code === "42501" || /row-level security/i.test(err.message || ""))) {
    return "이 방에 쓸 권한이 없어요. 링크를 다시 열어 주세요.";
  }
  return "저장에 실패했어요. 잠시 뒤 다시 시도해 주세요.";
}

/* ============================================================
   4. 방 연결
   ============================================================ */
function subscribeRoom() {
  var ch = sb.channel("room:" + roomId);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: "id=eq." + roomId }, fetchRoom);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "places", filter: "room_id=eq." + roomId }, fetchPlaces);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "voters", filter: "room_id=eq." + roomId }, fetchVoters);
  ch.subscribe();
}

async function attachRoom(code, id) {
  roomCode = code; roomId = id;
  sb = baseClient({ "x-room-code": code });
  await sb.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  sb.realtime.setAuth(session.access_token);
  location.hash = "#" + code;
  await fetchRoom(); await fetchPlaces(); await fetchVoters();
  subscribeRoom();
  schedule();
}

async function createRoom() {
  var code = makeCode();
  var client = baseClient({ "x-room-code": code });
  await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  var r = await client.from("rooms").insert({ code: code }).select("id").single();
  if (r.error) { say("방을 만들지 못했어요. 다시 눌러 주세요."); return; }
  await attachRoom(code, r.data.id);
}

async function joinRoomByCode(code) {
  code = String(code || "").trim().toUpperCase();
  if (code.length < 4) { say("코드를 정확히 입력해 주세요."); return; }
  var client = baseClient({ "x-room-code": code });
  await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  var r = await client.from("rooms").select("id").eq("code", code).maybeSingle();
  if (r.error || !r.data) { say("그런 방이 없어요. 코드를 다시 확인해 주세요."); return; }
  await attachRoom(code, r.data.id);
}

async function initStore() {
  if (!CONFIGURED) { mode = "local"; localLoad(); schedule(); return; }
  try {
    await ensureSession();
    mode = "shared";
    var hash = (location.hash || "").replace(/^#\/?/, "").trim().toUpperCase();
    if (hash) await joinRoomByCode(hash);
  } catch (e) {
    // 익명 로그인이 꺼져 있으면 여기로 옵니다.
    bootError = (e && e.message) || "연결 실패";
    mode = "local"; localLoad();
  }
  schedule();
}

/* ============================================================
   5. tally
   ============================================================ */
function tally(round) {
  var cands = candidateIds(), counts = {}, n = 0;
  cands.forEach(function (id) { counts[id] = 0; });
  S.ballots.forEach(function (b) {
    if (b.round !== round) return;
    n++;
    (b.entries || []).forEach(function (e) { if (counts[e.place] != null) counts[e.place]++; });
  });
  var rows = cands.map(function (id) { return { id: id, n: counts[id], name: placeName(id) }; });
  rows.sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name, "ko"); });
  return { rows: rows, ballots: n };
}

function topTier(rows, want) {
  var out = [], last = null;
  for (var i = 0; i < rows.length; i++) {
    if (out.length >= want && rows[i].n !== last) break;
    out.push(rows[i].id); last = rows[i].n;
    if (out.length >= 8) break;
  }
  return out;
}

function outcome(round) {
  var t = tally(round), rows = t.rows;
  if (!rows.length) return { kind: "empty", rows: rows, ballots: t.ballots };
  var top = rows[0].n;
  var leaders = rows.filter(function (r) { return r.n === top; });
  if (top === 0) return { kind: "tie", why: "novote", finalists: topTier(rows, 3), rows: rows, ballots: t.ballots };

  if (leaders.length === 1) {
    if (round === 1) {
      if (top * 2 > t.ballots) return { kind: "win", winner: leaders[0].id, rows: rows, ballots: t.ballots, majority: true };
      return { kind: "tie", why: "nomajority", finalists: topTier(rows, 3), rows: rows, ballots: t.ballots };
    }
    return { kind: "win", winner: leaders[0].id, rows: rows, ballots: t.ballots };
  }
  if (round === 1) return { kind: "tie", why: "tie", finalists: topTier(rows, 3), rows: rows, ballots: t.ballots };
  return { kind: "tie", why: "tie", finalists: leaders.map(function (r) { return r.id; }), rows: rows, ballots: t.ballots };
}

/* ============================================================
   6. 번역기 말투 변환 — 서버도 API 키도 없이 브라우저에서 바로 돕니다.
      완벽한 문법 교정이 아니라 "말투 지문 지우기"가 목적입니다. 결정적(deterministic)이라
      누가 써도 같은 문체로 수렴하고, 그게 익명성에 도움이 됩니다.
   ============================================================ */

/* 지문 제거: 이모지, 자음·모음 단독(ㅋㅋ ㅠㅠ), 반복 부호, 물결 */
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

/* 은어·줄임말 → 표준 어휘. 어미를 먹지 않도록 단어 통째로 ㅁ체에 맞춰 매핑합니다. */
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

/* ㅁ으로 끝나지만 종결어미가 아닌 흔한 명사 — 문장 분리에서 제외 */
var NOT_ENDING = /^(다음|처음|마음|얼음|죽음|웃음|울음|걸음|게임|모임|소음|이음|봄|밤|담|샴|팀|셈|점|힘|참)$/;

/* 종결어미 → 격식체. 자주 쓰는 용언 먼저, 그다음 일반 규칙.
   대안(|)마다 캡처 그룹을 따로 두면 $1 이 비어 문장이 통째로 날아갑니다. */
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
  return s + ".";   // 규칙에 없으면 그대로 두고 마침표만
}

function translatorize(raw) {
  var s = cleanTone(raw);
  LEXICON.forEach(function (r) { s = s.replace(r[0], r[1]); });

  // 문장부호 없이 이어 쓴 글을 ㅁ체 경계에서 끊어 줍니다.
  s = s.replace(/([가-힣]{0,6}[음함임됨듦])\s+(?=[가-힣])/g, function (m, w) {
    return NOT_ENDING.test(w) ? m : w + ". ";
  });

  return s.split(/(?<=[.?])\s*/)
    .filter(function (p) { return p.trim(); })
    .map(formalize)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function convert(placeId) {
  var raw = (draft.raw[placeId] || "").trim();
  if (!raw) return;
  if (chars(raw) > COMMENT_MAX) {
    draft.status[placeId] = "error";
    draft.err[placeId] = "원문이 " + COMMENT_MAX + "자를 넘었어요. 줄여 주세요.";
    render();
    return;
  }
  var out = translatorize(raw);
  if (!out) {
    draft.status[placeId] = "error";
    draft.err[placeId] = "바꿀 내용이 없어요. 다시 적어 주세요.";
  } else {
    draft.ai[placeId] = out.slice(0, COMMENT_MAX);
    draft.status[placeId] = "ready";
    draft.err[placeId] = "";
  }
  render();
}

/* ============================================================
   7. draft
   ============================================================ */
function resetDraft(round) { draft = { round: round, picks: [], raw: {}, ai: {}, status: {}, err: {} }; }
function ensureDraft() { var r = M().round; if (!draft || draft.round !== r) resetDraft(r); return draft; }
function commentFor(id) {
  if (draft.status[id] === "ready") return (draft.ai[id] || "").trim();
  if (draft.status[id] === "raw") return (draft.raw[id] || "").trim();
  return "";
}
function draftBlocked() {
  var bad = [];
  draft.picks.forEach(function (id) {
    var raw = (draft.raw[id] || "").trim();
    if (!raw) return;
    if (chars(raw) > COMMENT_MAX) { bad.push(id); return; }
    if (draft.status[id] !== "ready" && draft.status[id] !== "raw") bad.push(id);
  });
  return bad;
}
function canSubmit() { return draft && draft.picks.length > 0 && draftBlocked().length === 0; }

/* ============================================================
   8. actions
   ============================================================ */
function say(msg) { toast = msg; render(); setTimeout(function () { if (toast === msg) { toast = ""; render(); } }, 2800); }

async function joinAsName(name) {
  name = String(name || "").trim().slice(0, 12);
  if (!name) { say("이름을 적어 주세요."); return; }
  ensureCid(); me.name = name; LS.set("tv_name", name);
  var v = myVoter();
  await store.setVoter({ client_id: me.id, name: name, rounds: (v && v.rounds) || {} });
  if (mode === "local" && !S.meta) await store.setMeta({});
  render();
}

async function addPlace() {
  var el = document.querySelector('[data-keep="newplace"]');
  var el2 = document.querySelector('[data-keep="newnote"]');
  var name = el ? el.value.trim() : "";
  var note = el2 ? el2.value.trim() : "";
  if (!name) { say("여행지 이름을 적어 주세요."); return; }
  if (S.places.length >= 24) { say("여행지는 24곳까지 넣을 수 있어요."); return; }
  if (S.places.some(function (p) { return p.name.replace(/\s/g, "") === name.replace(/\s/g, ""); })) {
    say("이미 올라와 있는 곳이에요."); return;
  }
  await store.addPlace({ name: name.slice(0, 28), note: note.slice(0, 60), added_by: me.name, sort: Date.now() });
  if (el) el.value = ""; if (el2) el2.value = "";
  render();
  if (el) el.focus({ preventScroll: true });
}

async function startVote() {
  if (S.places.length < 2) { say("여행지를 2곳 이상 올려 주세요."); return; }
  resetDraft(1);
  await store.setMeta({
    phase: "vote", round: 1,
    candidates: S.places.map(function (p) { return p.id; }),
    winner: null, spin: null, tiebreak: null, finalists: []
  });
}

function togglePick(id) {
  var d = ensureDraft(), max = votesFor(d.round);
  var i = d.picks.indexOf(id);
  if (i >= 0) d.picks.splice(i, 1);
  else {
    if (d.picks.length >= max) { say(max + "표까지만 쓸 수 있어요. 하나를 빼고 다시 골라 주세요."); return; }
    d.picks.push(id);
  }
  render();
}

async function submitBallot() {
  if (!canSubmit()) return;
  var round = draft.round;
  var entries = draft.picks.map(function (id) { return { place: id, comment: commentFor(id).slice(0, COMMENT_MAX) }; });
  var ok = await store.addBallot({ round: round, entries: shuffle(entries) });
  if (!ok) return;
  var v = myVoter() || { client_id: me.id, name: me.name, rounds: {} };
  var rounds = Object.assign({}, v.rounds || {}); rounds["r" + round] = true;
  await store.setVoter({ client_id: me.id, name: v.name || me.name, rounds: rounds });
  modalView = null; draft = null;
  if (mode === "local") modalView = "handoff";
  render();
}

async function openResult() { await store.setMeta({ phase: "result" }); if (mode === "shared") await fetchBallots(); }
async function confirmWin(id) { await store.setMeta({ phase: "done", winner: id }); }
async function goChoose(f) { await store.setMeta({ phase: "choose", finalists: f, candidates: f, tiebreak: null }); }
async function pickRevote() {
  var m = M(); resetDraft(m.round + 1);
  await store.setMeta({ phase: "vote", round: m.round + 1, candidates: m.finalists, tiebreak: "revote", spin: null });
}
async function pickWheel() { await store.setMeta({ phase: "wheel", tiebreak: "wheel", spin: null }); }
async function doSpin() {
  var cands = candidateIds();
  if (cands.length < 2) return;
  var idx = Math.floor(Math.random() * cands.length);
  var seg = 360 / cands.length;
  var deg = 360 * 7 - (idx + 0.5) * seg + (Math.random() - 0.5) * seg * 0.6;
  await store.setMeta({ spin: { id: uid(), deg: deg, idx: idx, order: cands }, winner: cands[idx] });
}

function nextPerson() {
  LS.del("tv_cid"); LS.del("tv_name");
  me = { id: "", name: "" };
  draft = null; modalView = null;
  render();
}

async function copyLink() {
  var url = location.origin + location.pathname + "#" + roomCode;
  try {
    await navigator.clipboard.writeText(url);
    say("링크를 복사했어요. 단톡방에 붙여넣으세요.");
  } catch (e) {
    say("복사가 안 됐어요. 주소창의 링크를 직접 복사해 주세요.");
  }
}

/* ============================================================
   9. render
   ============================================================ */
var pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  setTimeout(function () { pending = false; render(); }, 16);
}

var keepFocus = { id: null, s: 0, e: 0 };
function captureFocus() {
  var el = document.activeElement;
  if (el && el.dataset && el.dataset.keep) {
    keepFocus.id = el.dataset.keep;
    try { keepFocus.s = el.selectionStart; keepFocus.e = el.selectionEnd; } catch (err) {}
  } else keepFocus.id = null;
}
function restoreFocus() {
  if (!keepFocus.id) return;
  var el = document.querySelector('[data-keep="' + keepFocus.id + '"]');
  if (!el) return;
  el.focus({ preventScroll: true });
  try { el.setSelectionRange(keepFocus.s, keepFocus.e); } catch (err) {}
}

var STEPS = [
  { k: "lobby", label: "01 모으기" },
  { k: "vote1", label: "02 1차 투표" },
  { k: "final", label: "03 결선" },
  { k: "done", label: "04 확정" }
];
function stepKey() {
  var m = M();
  if (m.phase === "lobby") return "lobby";
  if (m.phase === "done") return "done";
  if (m.phase === "vote" || m.phase === "result") return m.round === 1 ? "vote1" : "final";
  return "final";
}

function needsRoom() { return mode === "shared" && !roomId; }
function needsName() {
  if (me.name && me.id) return false;
  var p = M().phase;
  return p === "lobby" || p === "vote";
}

function render() {
  captureFocus();
  var m = M();

  var who = mode === "connecting" ? "연결 중…"
    : mode === "local" ? "이 기기 전용"
    : !roomId ? "방 없음"
    : (me.name ? esc(me.name) : "이름 없음") + " · " + S.voters.length + "명";
  $("#who").innerHTML = who;

  var sk = stepKey(), cur = 0;
  STEPS.forEach(function (st, i) { if (st.k === sk) cur = i; });
  $("#steps").innerHTML = STEPS.map(function (st, i) {
    return '<li class="' + (i === cur ? "on" : (i < cur ? "past" : "")) + '">' + st.label + "</li>";
  }).join("");

  ensureRegistered();

  if (wheelBusy && m.phase === "wheel") return;

  var html = "";
  if (mode === "connecting") html = viewConnecting();
  else if (needsRoom()) html = viewRoomEntry();
  else if (needsName()) html = viewJoin();
  else if (m.phase === "lobby") html = viewLobby();
  else if (m.phase === "vote") html = viewVote();
  else if (m.phase === "result") html = viewResult();
  else if (m.phase === "choose") html = viewChoose();
  else if (m.phase === "wheel") html = viewWheel();
  else if (m.phase === "done") html = viewDone();
  $("#main").innerHTML = html;

  $("#dock").innerHTML = renderDock();
  $("#foot").innerHTML = renderFoot();
  $("#modal").innerHTML = renderModal();

  restoreFocus();
  if (m.phase === "wheel" && !needsRoom()) afterWheel();
}

var rejoinBusy = false;
function ensureRegistered() {
  if (mode === "connecting" || needsRoom() || !me.id || !me.name) return;
  if (myVoter() || rejoinBusy) return;
  rejoinBusy = true;
  Promise.resolve(store.setVoter({ client_id: me.id, name: me.name, rounds: {} }))
    .then(function () { rejoinBusy = false; }, function () { rejoinBusy = false; });
}

function toastHTML() {
  return toast ? '<div class="notice"><span class="ic">!</span><span>' + esc(toast) + "</span></div>" : "";
}

function modeBanner() {
  if (mode === "local") {
    return '<div class="banner"><span class="mk">단말 모드</span><span>' +
      (CONFIGURED
        ? "서버에 연결하지 못했어요. 지금은 <b>이 기기에만</b> 저장됩니다."
        : "아직 서버 설정 전이라 <b>이 기기에만</b> 저장돼요. 폰을 돌려가며 한 명씩 투표하면 됩니다.") +
      "</span></div>";
  }
  return '<div class="banner"><span class="mk">실시간</span><span>같은 링크를 연 사람 모두에게 바로 반영돼요.</span></div>';
}

function shareCard() {
  if (mode !== "shared" || !roomCode) return "";
  return '<div class="panel stack-sm">' +
    '<div class="eyebrow">방 코드</div>' +
    '<div class="codebox">' + esc(roomCode) + "</div>" +
    '<button class="btn block" data-act="copylink">링크 복사해서 단톡방에 뿌리기</button>' +
    '</div>';
}

/* ---- connecting ---- */
function viewConnecting() {
  return '<div class="panel stack"><div class="eyebrow">잠깐만요</div><h1 class="title">연결하는 중…</h1>' +
    '<p class="lede">서버에 붙는 중이에요. 연결이 안 되면 이 기기에서 폰을 돌려가며 쓰는 모드로 전환됩니다.</p></div>';
}

/* ---- 방 만들기 / 들어가기 ---- */
function viewRoomEntry() {
  return toastHTML() +
    '<div class="stack">' +
      '<div><div class="eyebrow">시작</div><h1 class="title">방을 만들거나, 코드로 들어오세요</h1></div>' +
      '<p class="lede">방을 만들면 링크가 나옵니다. 그 링크를 단톡방에 뿌리면 친구들이 각자 폰에서 들어와요.</p>' +
    "</div>" +
    '<div class="panel stack-sm">' +
      '<button class="btn primary block" data-act="createroom">새 방 만들기</button>' +
    "</div>" +
    '<div class="panel stack-sm">' +
      '<div class="eyebrow">이미 방이 있다면</div>' +
      '<input class="field uppercase" data-keep="roomcode" maxlength="6" placeholder="코드 6자리" autocomplete="off" autocapitalize="characters">' +
      '<button class="btn block" data-act="joinroom">코드로 들어가기</button>' +
    "</div>";
}

/* ---- 이름 ---- */
function viewJoin() {
  return toastHTML() +
    '<div class="panel stack">' +
      '<div class="eyebrow">참가</div>' +
      '<h1 class="title">이름부터 알려 주세요</h1>' +
      '<p class="lede">누가 투표를 마쳤는지 표시하는 데만 써요. <b>어디에 표를 줬는지, 어떤 코멘트를 썼는지는 이름과 연결되지 않습니다.</b></p>' +
      '<input class="field" data-keep="joinname" maxlength="12" placeholder="예: 지수" value="' + esc(me.name) + '" autocomplete="off">' +
      '<button class="btn primary block" data-act="join">들어가기</button>' +
    "</div>" +
    allDoneShortcut() + modeBanner();
}

function allDoneShortcut() {
  var m = M();
  if (m.phase !== "vote" || !S.voters.length) return "";
  if (votedCount(m.round) < S.voters.length) return "";
  return '<div class="panel stack-sm">' +
    '<div class="eyebrow">' + S.voters.length + "명 모두 투표 완료</div>" +
    '<button class="btn gold block" data-act="openresult">결과 열기</button></div>';
}

/* ---- lobby ---- */
function viewLobby() {
  var list = S.places.map(function (p, i) {
    return '<div class="ticket">' +
      '<div class="stub"><span class="code">' + pad2(i + 1) + "</span></div>" +
      '<div class="tbody"><div style="display:flex;gap:10px;align-items:flex-start">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="tname">' + esc(p.name) + "</div>" +
          (p.note ? '<div class="tnote">' + esc(p.note) + "</div>" : "") +
          (p.added_by ? '<div class="tby">' + esc(p.added_by) + " 추가</div>" : "") +
        "</div>" +
        '<button class="btn sm ghost" data-act="delplace" data-id="' + p.id + '">삭제</button>' +
      "</div></div></div>";
  }).join("");

  return toastHTML() +
    '<div class="stack">' +
      '<div><div class="eyebrow">단계 01</div><h1 class="title">가고 싶은 곳을 다 던져 봐요</h1></div>' +
      '<p class="lede">떠오르는 대로 올려도 돼요. 1차 투표에서 <b>한 명당 2표</b>로 걸러냅니다.</p>' +
    "</div>" +
    shareCard() +
    '<div class="panel stack-sm">' +
      '<input class="field" data-keep="newplace" maxlength="28" placeholder="여행지 이름" autocomplete="off">' +
      '<input class="field" data-keep="newnote" maxlength="60" placeholder="한 줄 메모 (선택)" autocomplete="off">' +
      '<button class="btn primary block" data-act="addplace">목록에 추가</button>' +
    "</div>" +
    (S.places.length
      ? '<div class="stack" style="gap:14px">' + list + "</div>"
      : '<p class="muted" style="text-align:center;padding:14px 0">아직 올라온 곳이 없어요.</p>') +
    '<div class="stack-sm"><div class="eyebrow">참가자 ' + S.voters.length + "명</div>" +
      '<div class="chips">' + S.voters.map(function (v) { return '<span class="chip">' + esc(v.name) + "</span>"; }).join("") + "</div></div>" +
    modeBanner();
}

/* ---- vote ---- */
function viewVote() {
  var m = M(), d = ensureDraft(), mine = myVoter();
  var cands = candidateIds(), max = votesFor(m.round);

  var progress = '<div class="stack-sm">' +
    '<div class="eyebrow">' + votedCount(m.round) + " / " + S.voters.length + "명 완료</div>" +
    '<div class="chips">' + S.voters.map(function (v) {
      return '<span class="chip' + (hasVoted(v, m.round) ? " done" : "") + '"><span class="mk">' +
        (hasVoted(v, m.round) ? "✓" : "·") + "</span>" + esc(v.name) + "</span>";
    }).join("") + "</div></div>";

  if (hasVoted(mine, m.round)) {
    return toastHTML() +
      '<div class="panel stack">' +
        '<div class="eyebrow">' + (m.round === 1 ? "1차 투표" : "결선 " + (m.round - 1) + "차") + "</div>" +
        '<h1 class="title">투표 완료</h1>' +
        '<p class="lede">나머지 사람들을 기다리는 중이에요. 다 끝나면 아래 버튼으로 결과를 열 수 있어요.</p>' +
      "</div>" + progress;
  }

  var cardsHTML = cands.map(function (id, i) {
    var p = placeById(id); if (!p) return "";
    var picked = d.picks.indexOf(id) >= 0;
    return "<div>" +
      '<button class="tapcard" data-act="pick" data-id="' + id + '">' +
        '<div class="ticket' + (picked ? " pick" : "") + '">' +
          '<div class="stub"><span class="code">' + pad2(i + 1) + "</span></div>" +
          '<div class="tbody"><div style="display:flex;gap:11px;align-items:center">' +
            '<div style="flex:1;min-width:0">' +
              '<div class="tname">' + esc(p.name) + "</div>" +
              (p.note ? '<div class="tnote">' + esc(p.note) + "</div>" : "") +
            "</div><span class=\"checkbox\">✓</span></div></div>" +
        "</div></button>" +
      (picked ? composer(id) : "") + "</div>";
  }).join("");

  return toastHTML() +
    '<div class="stack">' +
      '<div><div class="eyebrow">' + (m.round === 1 ? "단계 02 · 1차 투표" : "단계 03 · 결선 " + (m.round - 1) + "차") + "</div>" +
      '<h1 class="title">' + (m.round === 1 ? "두 곳을 고르세요" : "한 곳만 고르세요") + "</h1></div>" +
      '<p class="lede">지금 <b>' + d.picks.length + " / " + max + "표</b> 썼어요. 고른 곳마다 이유를 남길 수 있고, 남긴 이유는 <b>번역기 말투로 바꾼 뒤에만</b> 제출돼요.</p>" +
    "</div>" +
    '<div class="stack" style="gap:14px">' + cardsHTML + "</div>" +
    progress;
}

function composer(id) {
  var st = draft.status[id] || "idle";
  var raw = draft.raw[id] || "", ai = draft.ai[id] || "", err = draft.err[id] || "";
  var len = chars(raw), over = len > COMMENT_MAX;

  var tag = st === "ready" ? '<span class="tag ok" id="tag-' + id + '">변환 완료</span>'
    : st === "raw" ? '<span class="tag warn" id="tag-' + id + '">원문 그대로</span>'
    : st === "busy" ? '<span class="tag" id="tag-' + id + '">변환 중…</span>'
    : raw.trim() ? '<span class="tag warn" id="tag-' + id + '">변환 필요</span>'
    : '<span class="tag" id="tag-' + id + '">선택 사항</span>';

  var body;
  if (st === "busy") {
    body = '<div class="aibox" id="ai-' + id + '">AI가 말투를 바꾸는 중…<span class="caret"></span></div>';
  } else if (st === "ready") {
    body = '<div class="aibox" id="ai-' + id + '">' + esc(ai) + "</div>" +
      '<p class="muted">이 문장이 그대로 제출돼요. 내용이 맞는지 확인해 주세요. 원문은 저장되지 않습니다.</p>' +
      '<div class="btn-row">' +
        '<button class="btn sm" data-act="convert" data-id="' + id + '">다시 변환</button>' +
        '<button class="btn sm ghost" data-act="unlock" data-id="' + id + '">원문 고치기</button>' +
      "</div>";
  } else if (st === "raw") {
    body = '<div class="aibox" id="ai-' + id + '">' + esc(raw) + "</div>" +
      '<p class="muted">변환 없이 이대로 제출돼요. 말투로 누군지 드러날 수 있어요.</p>' +
      '<div class="btn-row">' +
        '<button class="btn sm" data-act="convert" data-id="' + id + '">번역기 말투로 바꾸기</button>' +
        '<button class="btn sm ghost" data-act="unlock" data-id="' + id + '">고치기</button>' +
      "</div>";
  } else {
    body = (err ? '<div class="aibox err">' + esc(err) + "</div>" : "") +
      '<div class="btn-row">' +
        '<button class="btn sm primary" data-act="convert" data-id="' + id + '"' + (raw.trim() && !over ? "" : " disabled") + ">번역기 말투로 바꾸기</button>" +
        '<button class="btn sm ghost" data-act="useraw" data-id="' + id + '"' + (raw.trim() && !over ? "" : " disabled") + ">원문 그대로 쓰기</button>" +
        
      "</div>";
  }

  var editor = (st === "ready" || st === "raw" || st === "busy") ? "" :
    '<textarea class="field" data-keep="raw-' + id + '" data-raw="' + id + '" maxlength="' + COMMENT_MAX + '" ' +
    'placeholder="여기는 평소 말투 그대로 편하게 쓰세요. 제출 전에 번역기 말투로 바꿔 줄게요.">' + esc(raw) + "</textarea>" +
    '<div class="counter' + (over ? " over" : "") + '" id="cnt-' + id + '">' + len + " / " + COMMENT_MAX + "</div>";

  return '<div class="compose">' +
    '<div class="compose-head"><span class="eyebrow">고른 이유</span>' + tag + "</div>" +
    editor + body + "</div>";
}

/* ---- result ---- */
function viewResult() {
  var m = M(), o = outcome(m.round);
  var maxN = Math.max.apply(null, o.rows.map(function (r) { return r.n; }).concat([1]));

  var rank = o.rows.map(function (r, i) {
    var lead = r.n === o.rows[0].n && r.n > 0;
    return '<div class="rrow' + (lead ? " lead" : "") + '">' +
      '<div class="rpos">' + pad2(i + 1) + "</div>" +
      '<div class="rname">' + esc(r.name) + "</div>" +
      '<div class="rnum">' + r.n + "표</div></div>" +
      '<div class="bar"><span style="width:' + Math.round(r.n / maxN * 100) + "%;background:" + (lead ? "var(--gold)" : "var(--teal)") + '"></span></div>';
  }).join("");

  var head, note;
  if (o.kind === "win") {
    head = '<h1 class="title">' + esc(placeName(o.winner)) + " 확정!</h1>";
    note = m.round === 1
      ? '<p class="lede">' + o.ballots + "명 중 <b>" + o.rows[0].n + "명</b>이 골랐어요. 과반이라 바로 확정할 수 있어요.</p>"
      : '<p class="lede">단독 1등이에요. 결선 끝!</p>';
  } else if (o.kind === "empty") {
    head = '<h1 class="title">집계할 표가 없어요</h1>'; note = "";
  } else {
    head = '<h1 class="title">' + (o.why === "tie" ? "동점이 나왔어요" : "과반이 안 나왔어요") + "</h1>";
    note = '<p class="lede">' +
      (m.round === 1 ? "상위 <b>" + o.finalists.length + "곳</b>만 남기고 결선으로 갑니다."
                     : "<b>" + o.finalists.length + "곳</b>이 같은 표를 받았어요.") +
      " 재투표할지 돌림판을 돌릴지 다음 화면에서 고르세요.</p>";
  }

  var finalChips = (o.kind === "tie" && o.finalists.length)
    ? '<div class="stack-sm"><div class="eyebrow">결선 진출</div><div class="chips">' +
      o.finalists.map(function (id) { return '<span class="chip done">' + esc(placeName(id)) + "</span>"; }).join("") + "</div></div>"
    : "";

  return toastHTML() +
    '<div class="stack"><div><div class="eyebrow">' +
      (m.round === 1 ? "1차 투표 결과" : "결선 " + (m.round - 1) + "차 결과") + " · " + o.ballots + "명 참여</div>" + head + "</div>" + note + "</div>" +
    '<div class="panel"><div class="rank">' + rank + "</div></div>" +
    finalChips + commentsPanel(m.round);
}

function commentsPanel(round) {
  var byPlace = {};
  S.ballots.forEach(function (b) {
    if (b.round !== round) return;
    (b.entries || []).forEach(function (e) {
      if (!e.comment) return;
      (byPlace[e.place] = byPlace[e.place] || []).push(e.comment);
    });
  });
  var ids = Object.keys(byPlace);
  if (!ids.length) return '<p class="muted" style="text-align:center;padding:8px 0">이번 라운드엔 코멘트가 없었어요.</p>';
  ids.sort(function (a, b) { return byPlace[b].length - byPlace[a].length; });
  return '<div class="stack"><div class="eyebrow">익명 코멘트</div>' +
    ids.map(function (id) {
      return '<div class="stack-sm"><h2 class="sub">' + esc(placeName(id)) + "</h2>" +
        byPlace[id].slice().sort().map(function (c) {
          return '<div class="cmt"><span class="anon">익명</span>' + esc(c) + "</div>";
        }).join("") + "</div>";
    }).join("") + "</div>";
}

/* ---- choose ---- */
function viewChoose() {
  var m = M();
  return toastHTML() +
    '<div class="stack">' +
      '<div><div class="eyebrow">결선 방식</div><h1 class="title">어떻게 끝낼까요?</h1></div>' +
      '<p class="lede"><b>' + (m.finalists || []).length + "곳</b>이 남았어요. 한 번 더 투표하거나, 그냥 운에 맡기거나.</p>" +
      '<div class="chips">' + (m.finalists || []).map(function (id) { return '<span class="chip done">' + esc(placeName(id)) + "</span>"; }).join("") + "</div>" +
    "</div>" +
    '<div class="pill-toggle">' +
      '<button class="btn" data-act="revote"><span class="k">재투표</span><span class="d">한 명당 1표<br>코멘트도 다시</span></button>' +
      '<button class="btn" data-act="wheel"><span class="k">돌림판</span><span class="d">운에 맡기기<br>한 방에 결정</span></button>' +
    "</div>" +
    '<p class="muted" style="text-align:center">아무나 눌러도 돼요. 모두의 화면이 같이 넘어갑니다.</p>';
}

/* ---- wheel ---- */
var SEG_FILL = ["#12665C", "#B36F16", "#2F5A73", "#8A3F3F", "#4E6B2F", "#63457A", "#1C7F6E", "#A2622A"];

function viewWheel() {
  var m = M();
  var cands = (m.spin && m.spin.order && m.spin.order.length)
    ? m.spin.order.filter(function (id) { return !!placeById(id); })
    : candidateIds();
  var n = cands.length, seg = 360 / n, R = 92, C = 100;
  var paths = "", labels = "";
  for (var i = 0; i < n; i++) {
    var a0 = (i * seg - 90) * Math.PI / 180, a1 = ((i + 1) * seg - 90) * Math.PI / 180;
    var x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0);
    var x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
    paths += '<path d="M' + C + "," + C + " L" + x0.toFixed(2) + "," + y0.toFixed(2) +
      " A" + R + "," + R + " 0 " + (seg > 180 ? 1 : 0) + " 1 " + x1.toFixed(2) + "," + y1.toFixed(2) +
      ' Z" fill="' + SEG_FILL[i % SEG_FILL.length] + '" stroke="rgba(255,255,255,.45)" stroke-width="1.2"/>';

    var am = ((i + 0.5) * seg - 90) * Math.PI / 180;
    var lr = n <= 4 ? 50 : 58;
    var lx = C + lr * Math.cos(am), ly = C + lr * Math.sin(am);
    var fs = n <= 4 ? 12 : n <= 6 ? 10 : 8.5;
    var cap = n <= 4 ? 8 : n <= 6 ? 6 : 5;
    var nm = placeName(cands[i]);
    if (nm.length > cap) nm = nm.slice(0, cap - 1) + "…";
    labels += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" fill="#fff" font-size="' + fs +
      '" font-family="IBM Plex Sans KR, sans-serif" font-weight="600" text-anchor="middle" dominant-baseline="middle"' +
      ' paint-order="stroke" stroke="rgba(0,0,0,.28)" stroke-width="2">' + esc(nm) + "</text>";
  }

  var revealed = !!(m.spin && spinSeen[m.spin.id] === "done");
  return toastHTML() +
    '<div class="stack"><div><div class="eyebrow">돌려돌려 돌림판</div>' +
      '<h1 class="title">' + (revealed ? "결과 나왔습니다" : "한 방에 정합니다") + "</h1></div>" +
      '<p class="lede">' + (revealed
        ? "바늘이 가리킨 곳은 <b>" + esc(placeName(m.winner)) + "</b>."
        : "아무나 한 번만 돌리면 돼요. 모두의 화면에서 같이 돌아갑니다.") + "</p></div>" +
    '<div class="wheelwrap"><div class="needle"></div>' +
      '<svg viewBox="0 0 200 200" aria-hidden="true"><g id="wheelspin">' + paths + labels + "</g>" +
      '<circle cx="100" cy="100" r="92" fill="none" stroke="var(--line)" stroke-width="2"/></svg>' +
      '<div class="hub">SPIN</div></div>' +
    (revealed ? '<div class="big-result"><div class="kicker">Winner</div><div class="name">' + esc(placeName(m.winner)) + "</div></div>" : "");
}

function afterWheel() {
  var m = M(), g = document.getElementById("wheelspin");
  if (!g) return;
  if (!m.spin) { g.style.transform = "rotate(0deg)"; return; }
  var st = spinSeen[m.spin.id];
  if (st === "done" || st === "running") { if (st === "done") g.style.transform = "rotate(" + m.spin.deg + "deg)"; return; }

  spinSeen[m.spin.id] = "running";
  wheelBusy = true;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var dur = reduce ? 400 : 5200;
  var spinId = m.spin.id, deg = m.spin.deg;
  g.style.transition = "none";
  g.style.transform = "rotate(0deg)";
  void g.getBoundingClientRect();
  setTimeout(function () {
    g.style.transition = "transform " + dur + "ms cubic-bezier(.14,.78,.16,1)";
    g.style.transform = "rotate(" + deg + "deg)";
  }, 20);
  setTimeout(function () { spinSeen[spinId] = "done"; wheelBusy = false; render(); }, dur + 120);
}

/* ---- done ---- */
function viewDone() {
  var m = M(), p = placeById(m.winner);
  var how = m.tiebreak === "wheel" ? "돌림판으로 결정" : m.round > 1 ? "결선 투표로 결정" : "1차 투표 과반으로 결정";
  var allComments = "";
  for (var r = 1; r <= m.round; r++) {
    var block = commentsPanel(r);
    if (block.indexOf("코멘트가 없었어요") >= 0) continue;
    allComments += (m.round > 1
      ? '<div class="stack-sm"><div class="eyebrow">' + (r === 1 ? "1차 투표" : "결선 " + (r - 1) + "차") + " 코멘트</div>" + block + "</div>"
      : block);
  }
  return toastHTML() +
    '<div class="big-result">' +
      '<div class="kicker">우리 갈 곳</div>' +
      '<div class="name">' + esc(p ? p.name : "?") + "</div>" +
      (p && p.note ? '<p class="lede" style="text-align:center">' + esc(p.note) + "</p>" : "") +
      '<p class="muted" style="margin-top:8px">' + how + "</p>" +
    "</div>" +
    '<div class="ticket win"><div class="stub"><span class="code">GO</span></div>' +
      '<div class="tbody"><div class="tname">' + esc(p ? p.name : "?") + "</div>" +
      '<div class="tby">' + S.voters.length + "명 · " + m.round + "라운드 · " + new Date().toLocaleDateString("ko-KR") + "</div></div></div>" +
    allComments;
}

/* ============================================================
   10. dock / foot / modal
   ============================================================ */
function renderDock() {
  var m = M(), inner = "", hint = "";
  if (mode === "connecting" || needsRoom() || needsName()) return "";

  if (m.phase === "lobby") {
    inner = '<button class="btn primary block" data-act="startvote"' + (S.places.length < 2 ? " disabled" : "") + ">1차 투표 시작 · 한 명당 2표</button>";
    hint = S.places.length < 2 ? "여행지를 2곳 이상 올리면 시작할 수 있어요." : S.places.length + "곳 · 참가자 " + S.voters.length + "명";
  } else if (m.phase === "vote") {
    if (hasVoted(myVoter(), m.round)) {
      var all = S.voters.length > 0 && votedCount(m.round) === S.voters.length;
      inner = '<button class="btn ' + (all ? "primary " : "") + 'block" data-act="openresult">결과 열기</button>';
      hint = all ? "모두 투표를 마쳤어요." : (S.voters.length - votedCount(m.round)) + "명이 아직이에요. 지금 열면 그대로 집계됩니다.";
    } else {
      var blocked = draft ? draftBlocked() : [];
      inner = '<button class="btn primary block" data-act="review"' + (canSubmit() ? "" : " disabled") + ">확인하고 투표하기</button>";
      hint = !draft || draft.picks.length === 0 ? "최소 한 곳은 골라 주세요."
        : blocked.length ? "코멘트를 쓴 곳은 " + COMMENT_MAX + "자 이내로 줄이고 말투 변환까지 마쳐야 제출할 수 있어요."
        : draft.picks.length + "곳 선택함";
    }
  } else if (m.phase === "result") {
    var o = outcome(m.round);
    if (o.kind === "win") inner = '<button class="btn gold block" data-act="confirmwin" data-id="' + o.winner + '">여기로 확정하기</button>';
    else if (o.kind === "empty") inner = '<button class="btn block" data-act="backvote">투표로 돌아가기</button>';
    else inner = '<button class="btn primary block" data-act="gochoose" data-ids="' + o.finalists.join(",") + '">결선 방식 고르기</button>';
  } else if (m.phase === "wheel") {
    var revealed = !!(m.spin && spinSeen[m.spin.id] === "done");
    if (revealed) inner = '<button class="btn gold block" data-act="confirmwin" data-id="' + m.winner + '">여기로 확정하기</button>';
    else if (m.spin) inner = '<button class="btn block" disabled>돌아가는 중…</button>';
    else inner = '<button class="btn primary block" data-act="spin">돌리기</button>';
  } else if (m.phase === "done") {
    inner = '<button class="btn block" data-act="askreset">새 투표 시작하기</button>';
    hint = "지금까지 기록은 모두 지워져요.";
  }
  if (!inner) return "";
  return '<div class="dock"><div class="dock-in">' + inner + (hint ? '<div class="hint">' + esc(hint) + "</div>" : "") + "</div></div>";
}

function renderFoot() {
  if (mode === "connecting" || needsRoom() || needsName()) return "";
  var m = M(), bits = [];
  if (m.phase !== "done") bits.push('<button data-act="askreset">처음부터 다시</button>');
  if (mode === "local" && m.phase === "vote") bits.push('<button data-act="next">다음 사람에게 넘기기</button>');
  if (mode === "shared" && m.phase !== "lobby") bits.push('<button data-act="copylink">링크 복사</button>');
  return bits.join(" · ");
}

function renderModal() {
  if (!modalView) return "";
  if (modalView === "confirm") {
    var rows = draft.picks.map(function (id) {
      var c = commentFor(id);
      return '<div class="stack-sm"><h2 class="sub">' + esc(placeName(id)) + "</h2>" +
        (c ? '<div class="cmt"><span class="anon">제출될 코멘트</span>' + esc(c) + "</div>"
           : '<p class="muted">코멘트 없이 표만 갑니다.</p>') + "</div>";
    }).join("");
    return '<div class="scrim" data-act="closemodal"><div class="sheet" data-stop="1"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">마지막 확인</div>' +
      '<h1 class="title" style="font-size:22px">이대로 제출할까요?</h1></div>' +
      '<p class="lede">제출 뒤에는 고칠 수 없어요. 이름은 함께 저장되지 않습니다.</p>' + rows +
      '<div class="btn-row" style="margin-top:6px">' +
        '<button class="btn primary" style="flex:1" data-act="submit">제출하기</button>' +
        '<button class="btn ghost" data-act="closemodal">더 고칠래요</button>' +
      "</div></div></div></div>";
  }
  if (modalView === "reset") {
    return '<div class="scrim" data-act="closemodal"><div class="sheet" data-stop="1"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">초기화</div>' +
      '<h1 class="title" style="font-size:22px">전부 지우고 다시 시작할까요?</h1></div>' +
      '<p class="lede">여행지 목록, 표, 코멘트가 모두 사라져요. 되돌릴 수 없습니다.</p>' +
      '<div class="btn-row">' +
        '<button class="btn" style="flex:1;border-color:var(--danger);color:var(--danger)" data-act="doreset">지우고 새로 시작</button>' +
        '<button class="btn ghost" data-act="closemodal">그만두기</button>' +
      "</div></div></div></div>";
  }
  if (modalView === "handoff") {
    return '<div class="scrim"><div class="sheet" data-stop="1"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">투표 완료</div>' +
      '<h1 class="title" style="font-size:22px">다음 사람에게 폰을 넘겨 주세요</h1></div>' +
      '<p class="lede">넘기기를 누르면 화면이 비워지고, 다음 사람이 이름부터 입력합니다. 방금 낸 표는 이미 익명으로 저장됐어요.</p>' +
      '<div class="btn-row">' +
        '<button class="btn primary" style="flex:1" data-act="next">넘기기</button>' +
        '<button class="btn ghost" data-act="closemodal">잠깐 볼게요</button>' +
      "</div></div></div></div>";
  }
  return "";
}

/* ============================================================
   11. events
   ============================================================ */
document.addEventListener("input", function (e) {
  var t = e.target;
  if (!t || !t.dataset) return;
  if (t.dataset.keep === "roomcode") { t.value = t.value.toUpperCase(); return; }
  if (!t.dataset.raw) return;

  ensureDraft();
  var id = t.dataset.raw;
  draft.raw[id] = t.value;
  var len = chars(t.value), filled = !!t.value.trim(), over = len > COMMENT_MAX;

  ["convert", "useraw"].forEach(function (a) {
    var btn = document.querySelector('[data-act="' + a + '"][data-id="' + id + '"]');
    if (btn) { if (filled && !over) btn.removeAttribute("disabled"); else btn.setAttribute("disabled", ""); }
  });
  var tg = document.getElementById("tag-" + id);
  if (tg) { tg.className = "tag" + (filled ? " warn" : ""); tg.textContent = filled ? "변환 필요" : "선택 사항"; }
  var cnt = document.getElementById("cnt-" + id);
  if (cnt) { cnt.className = "counter" + (over ? " over" : ""); cnt.textContent = len + " / " + COMMENT_MAX; }

  $("#dock").innerHTML = renderDock();
});

document.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  var t = e.target;
  if (!t || !t.dataset) return;
  if (t.dataset.keep === "joinname") { e.preventDefault(); joinAsName(t.value); }
  if (t.dataset.keep === "roomcode") { e.preventDefault(); joinRoomByCode(t.value); }
  if (t.dataset.keep === "newplace" || t.dataset.keep === "newnote") { e.preventDefault(); addPlace(); }
});

document.addEventListener("click", function (e) {
  var el = e.target.closest ? e.target.closest("[data-act]") : null;
  if (!el) return;
  if (el.classList.contains("scrim") && e.target !== el) return;
  var act = el.dataset.act, id = el.dataset.id;

  if (act === "createroom") createRoom();
  else if (act === "joinroom") { var f = document.querySelector('[data-keep="roomcode"]'); joinRoomByCode(f ? f.value : ""); }
  else if (act === "copylink") copyLink();
  else if (act === "join") { var j = document.querySelector('[data-keep="joinname"]'); joinAsName(j ? j.value : ""); }
  else if (act === "addplace") addPlace();
  else if (act === "delplace") store.delPlace(id);
  else if (act === "startvote") startVote();
  else if (act === "pick") togglePick(id);
  else if (act === "convert") convert(id);
  else if (act === "useraw") { ensureDraft(); draft.status[id] = "raw"; render(); }
  else if (act === "unlock") { ensureDraft(); draft.status[id] = "idle"; draft.err[id] = ""; render(); }
  else if (act === "review") { if (canSubmit()) { modalView = "confirm"; render(); } }
  else if (act === "submit") submitBallot();
  else if (act === "closemodal") { modalView = null; render(); }
  else if (act === "openresult") openResult();
  else if (act === "backvote") store.setMeta({ phase: "vote" });
  else if (act === "confirmwin") confirmWin(id);
  else if (act === "gochoose") goChoose((el.dataset.ids || "").split(",").filter(Boolean));
  else if (act === "revote") pickRevote();
  else if (act === "wheel") pickWheel();
  else if (act === "spin") doSpin();
  else if (act === "askreset") { modalView = "reset"; render(); }
  else if (act === "doreset") { modalView = null; draft = null; spinSeen = {}; store.resetAll(); }
  else if (act === "next") nextPerson();
});

/* 다른 기기에서 붙여넣은 링크로 이동했을 때 */
window.addEventListener("hashchange", function () {
  var code = (location.hash || "").replace(/^#\/?/, "").trim().toUpperCase();
  if (mode === "shared" && code && code !== roomCode) joinRoomByCode(code);
});

/* ============================================================
   12. boot
   ============================================================ */
render();
initStore();

})();
