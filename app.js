/* Moïse 다음 여행지
 *
 * 저장소는 두 갈래입니다.
 *   shared : Supabase (여러 폰에서 링크로 접속, 실시간 동기화)
 *   local  : config.js 가 비어 있거나 접속이 안 될 때. 한 기기에서 폰을 돌려가며 사용.
 *
 * 코멘트는 브라우저에서 규칙 기반으로 "번역기 말투"로 변환됩니다 (lib.js). 서버·API 키 없음.
 * 비행시간·항공권 가격은 data/places.js 의 고정 참고값이고, 전부 인천 출발 기준입니다.
 */
(function () {
"use strict";

var $ = function (s) { return document.querySelector(s); };
var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

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

var COMMENT_MAX = 100;
var VOTES_R1 = 3;   // 1차 투표에서 한 명이 쓰는 표. 결선은 항상 1표
var NUM_KO = { 1: "한", 2: "두", 3: "세", 4: "네", 5: "다섯" };
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  var out = "";
  for (var i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

var DEST = window.DESTINATIONS || [];
var ORIGIN = window.ORIGIN || { ko: "인천", code: "ICN", lat: 37.46, lon: 126.44 };

/* ============================================================
   1. config / supabase
   ============================================================ */
var CFG = window.TRIP_VOTE_CONFIG || {};
var CONFIGURED = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY &&
  CFG.SUPABASE_URL.indexOf("YOUR-") < 0 && CFG.SUPABASE_ANON_KEY.indexOf("YOUR-") < 0);

var sb = null, authClient = null, session = null;

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
var mode = "connecting";
var roomId = null, roomCode = null;

var me = { id: LS.get("tv_cid") || "", name: LS.get("tv_name") || "" };
function ensureCid() { if (!me.id) { me.id = uid(); LS.set("tv_cid", me.id); } return me.id; }
function roomKey() { return "tv_who_" + (roomCode || "local"); }
/* 내가 낸 표. 서버에 client_id 로 기록돼 있어 어느 기기에서든 찾을 수 있습니다.
   화면에는 여전히 이름 없이 보여 주지만, 서버는 알고 있습니다. */
function myBallot(round) {
  for (var i = 0; i < S.ballots.length; i++) {
    var b = S.ballots[i];
    if (b.round === round && b.client_id && b.client_id === me.id) return b;
  }
  return null;
}

/** 받침에 맞춘 조사. 받침이 없거나 ㄹ 이면 '로', 그 외에는 '으로'. */
function ro(name) {
  var last = String(name || "").trim().slice(-1);
  var code = last.charCodeAt(0);
  if (!(code >= 0xAC00 && code <= 0xD7A3)) return "로";
  var jong = (code - 0xAC00) % 28;
  return (jong === 0 || jong === 8) ? "로" : "으로";
}

var draft = null;          // 투표 작성 중
var dateSel = null;        // 날짜 고르는 중 (Set)
var editingDates = false;  // 이미 참가한 사람이 날짜만 다시 고를 때
var search = "";           // 여행지 검색어
var roomList = [];         // 방 목록 (코드 없이 이름으로 고름)
var newRoomYear = 2027;    // 새 방 만들 때 고른 연도
var vacDays = "";          // 휴가 일수 입력 중인 값
var delTarget = null;      // 삭제하려는 방
var votersLoaded = false;  // 참가자 목록을 한 번이라도 받아왔는가
var tagEditId = null;      // 태그 편집 중인 여행지
var tagDraft = [];         // 편집 중인 태그 목록
var tagText = "";          // 태그 입력창에 치고 있는 글자
var identified = false;    // 이 방에서 '나는 누구인지' 확인을 마쳤는가
var showHeat = false;      // 결과 화면의 달력 히트맵 펼침
var showPlaces = false;    // 확정 화면의 여행지 정보 펼침
var viewStep = null;       // 헤더 숫자로 지난 단계를 '보는 중' (방 단계는 그대로)
var titleEdit = false;     // 여행 이름 바꾸는 중
var codeDraft = "";        // 삭제 코드 입력값
var newRoomCode4 = "";     // 새 방 만들 때 정하는 삭제 코드
var newRoomTitle = "";     // 새 방 이름 입력값
var guardAction = null;    // 삭제 코드를 물어보는 중인 위험 동작
var editName = "";         // 표 수정 전에 확인용으로 입력하는 이름
var trashRooms = [];       // 지운 여행 (되돌릴 수 있음)
var trashPlaces = [];      // 지운 여행지
var trashBallots = 0;      // 지운 표 수 (이번 라운드)
var showTrash = false;     // 휴지통 펼침
var titleDraft = "";       // 바꾸는 중인 이름

var TAG_SUGGEST = ["맛집", "가성비", "휴양", "물놀이", "쇼핑", "야경", "자연", "도시",
  "부르주아", "뚜벅이", "인생샷", "가까움", "처음", "재방문"];
var TAG_MAX = 8;
var modalView = null;
var toast = "";
var spinSeen = {};
var wheelBusy = false;

function M() { return S.meta || DEFAULT_META; }

/* 방 단계를 1~5 숫자로. 1(참가·날짜)은 개인 단계라 방에는 없습니다. */
function stepOfPhase(m) {
  if (m.phase === "done") return 5;
  if (m.phase === "choose" || m.phase === "wheel") return 4;
  if (m.phase === "vote" || m.phase === "result") return m.round === 1 ? 3 : 4;
  return 2;
}
function reachedStep() {
  var m = M();
  var want = Math.max(m.reached || 2, stepOfPhase(m));
  // 표가 지워졌는데 기록만 남아 있으면 빈 화면으로 보내게 됩니다.
  // 실제 남아 있는 데이터로 상한을 다시 잡습니다.
  var hasR1 = false, hasLater = false;
  S.ballots.forEach(function (x) { if (x.round === 1) hasR1 = true; else if (x.round > 1) hasLater = true; });
  var cap = 2;
  if (hasR1) cap = 3;
  if (hasLater || (m.finalists || []).length) cap = 4;
  if (m.phase === "done" && m.winner) cap = 5;
  return Math.min(want, Math.max(cap, stepOfPhase(m)));
}
function liveStep() { return stepOfPhase(M()); }
function votesFor(round) { return round === 1 ? VOTES_R1 : 1; }
function placeById(id) { for (var i = 0; i < S.places.length; i++) if (S.places[i].id === id) return S.places[i]; return null; }
function placeName(id) { var p = placeById(id); return p ? p.name : "(삭제된 여행지)"; }
function candidateIds() {
  var m = M();
  var all = S.places.map(function (p) { return p.id; });
  if (m.phase === "lobby") return all;
  var c = (m.candidates || []).filter(function (id) { return !!placeById(id); });
  if (!c.length) return all;
  // 1차는 여행지 전체가 후보입니다. 지워져서 2곳 미만이면 지금 목록으로 다시 잡습니다.
  if (m.round === 1 && c.length < 2) return all;
  return c;
}
function myVoter() { for (var i = 0; i < S.voters.length; i++) if (S.voters[i].client_id === me.id) return S.voters[i]; return null; }
function hasVoted(v, round) { return !!(v && v.rounds && v.rounds["r" + round]); }
function votedCount(round) { var n = 0; S.voters.forEach(function (v) { if (hasVoted(v, round)) n++; }); return n; }
function voterDates(v) { return (v && Array.isArray(v.dates)) ? v.dates : []; }
function voterVac(v) { var n = v && v.vacation_days; return (typeof n === "number" && n > 0) ? n : null; }

/** 참가자들이 적어 낸 휴가 일수 중 가장 빠듯한 값 = 그룹 한도 */
function vacationLimit() {
  var vals = S.voters.map(voterVac).filter(Boolean);
  return vals.length ? Math.min.apply(null, vals) : null;
}

/** 가장 많이 겹치는 날짜 중, 휴가 한도에 들어가는 최장 연속 구간 */
function recommendation() {
  var best = bestDates();
  if (!best.max) return null;
  var C = window.TV.cal, limit = vacationLimit();
  var cands = C.runs(best.dates).map(function (run) {
    if (limit == null) return run;
    var i = 0, keep = [];
    for (var j = 0; j < run.length; j++) {
      while (C.weekdays(run.slice(i, j + 1)) > limit) i++;
      if (j - i + 1 > keep.length) keep = run.slice(i, j + 1);
    }
    return keep;
  }).filter(function (r) { return r.length; });
  if (!cands.length) return null;
  cands.sort(function (a, b) { return b.length - a.length; });
  return { dates: cands[0], people: best.max, limit: limit, weekdays: C.weekdays(cands[0]) };
}

/* ============================================================
   3. store
   ============================================================ */
var LKEY = "tv_local_room_v3";

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
  if (r.data) { S.meta = r.data; await fetchBallots(); }
  schedule();
}
async function fetchPlaces() {
  var r = await sb.from("places").select("*").eq("room_id", roomId).order("sort", { ascending: true });
  var all = r.data || [];
  S.places = all.filter(function (p) { return !p.deleted_at; });
  trashPlaces = all.filter(function (p) { return !!p.deleted_at; });
  schedule();
}
async function fetchVoters() {
  var r = await sb.from("voters").select("*").eq("room_id", roomId).order("joined_at", { ascending: true });
  if (r.error) return;
  S.voters = r.data || [];
  votersLoaded = true;
  schedule();
}
async function fetchBallots() {
  var r = await sb.from("ballots").select("*").eq("room_id", roomId).order("id", { ascending: true });
  var all = r.data || [];
  S.ballots = all.filter(function (b) { return !b.deleted_at; });
  var rd = M().round;
  trashBallots = all.filter(function (b) { return b.deleted_at && b.round === rd; }).length;
  schedule();
}

var store = {
  setMeta: async function (patch) {
    if (patch.phase) {
      var next = Object.assign({}, M(), patch);
      patch = Object.assign({}, patch, { reached: Math.max(M().reached || 2, stepOfPhase(next)) });
    }
    if (mode === "shared") {
      var r = await sb.from("rooms").update(patch).eq("id", roomId);
      if (r.error) { say(writeError(r.error)); return; }
      await fetchRoom();
    } else { S.meta = Object.assign({}, M(), patch); localSave(); schedule(); }
  },
  addPlace: async function (d) {
    if (mode === "shared") {
      var r = await sb.from("places").insert(Object.assign({ room_id: roomId }, d));
      if (r.error) { say(writeError(r.error)); return; }
      await fetchPlaces();
    } else { S.places.push(Object.assign({ id: uid() }, d)); localSave(); schedule(); }
  },
  updatePlace: async function (id, patch) {
    if (mode === "shared") {
      var r = await sb.from("places").update(patch).eq("id", id);
      if (r.error) { say(writeError(r.error)); return; }
      await fetchPlaces();
    } else {
      S.places = S.places.map(function (p) { return p.id === id ? Object.assign({}, p, patch) : p; });
      localSave(); schedule();
    }
  },
  delPlace: async function (id) {
    if (mode === "shared") {
      await sb.from("places").update({ deleted_at: new Date().toISOString() }).eq("id", id);
      await fetchPlaces();
    } else {
      var p = S.places.filter(function (x) { return x.id === id; })[0];
      if (p) trashPlaces.push(p);
      S.places = S.places.filter(function (x) { return x.id !== id; }); localSave(); schedule();
    }
  },
  purgePlace: async function (id) {
    if (mode === "shared") { await sb.from("places").delete().eq("id", id); await fetchPlaces(); }
    else { trashPlaces = trashPlaces.filter(function (x) { return x.id !== id; }); localSave(); schedule(); }
  },
  undelPlace: async function (id) {
    if (mode === "shared") {
      await sb.from("places").update({ deleted_at: null }).eq("id", id);
      await fetchPlaces();
    } else {
      var p = trashPlaces.filter(function (x) { return x.id === id; })[0];
      if (p) S.places.push(p);
      trashPlaces = trashPlaces.filter(function (x) { return x.id !== id; }); localSave(); schedule();
    }
  },
  setVoter: async function (v) {
    if (mode === "shared") {
      var r = await sb.from("voters").upsert(
        { room_id: roomId, client_id: v.client_id, name: v.name, rounds: v.rounds, dates: v.dates || [], vacation_days: v.vacation_days == null ? null : v.vacation_days },
        { onConflict: "room_id,client_id" });
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
      var r = await sb.from("ballots")
        .insert({ room_id: roomId, round: b.round, entries: b.entries, client_id: me.id })
        .select("id").single();
      if (r.error) { say(writeError(r.error)); return null; }
      await fetchBallots();
      return r.data.id;
    }
    var id = uid();
    S.ballots.push(Object.assign({ id: id, client_id: me.id }, b)); localSave(); schedule(); return id;
  },
  delBallot: async function (id) {
    if (mode === "shared") {
      await sb.from("ballots").delete().eq("id", id).eq("client_id", me.id);
      await fetchBallots();
    } else {
      S.ballots = S.ballots.filter(function (b) { return b.id !== id; }); localSave();
    }
  }
};

function writeError(err) {
  if (err && (err.code === "42501" || /row-level security/i.test(err.message || ""))) {
    return "이 방에 쓸 권한이 없어요. 링크를 다시 열어 주세요.";
  }
  if (err && /column|schema cache/i.test(err.message || "")) {
    return "DB 업데이트가 아직 안 됐어요. migration-002 SQL을 실행해 주세요.";
  }
  return "저장에 실패했어요. 잠시 뒤 다시 시도해 주세요.";
}

/* ============================================================
   4. 방 연결
   ============================================================ */
var roomChannel = null;
function subscribeRoom() {
  if (roomChannel) { try { sb.removeChannel(roomChannel); } catch (e) {} }
  var ch = sb.channel("room:" + roomId);
  roomChannel = ch;
  ch.on("postgres_changes", { event: "*", schema: "public", table: "rooms", filter: "id=eq." + roomId }, fetchRoom);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "places", filter: "room_id=eq." + roomId }, fetchPlaces);
  ch.on("postgres_changes", { event: "*", schema: "public", table: "voters", filter: "room_id=eq." + roomId }, fetchVoters);
  ch.subscribe();
}

/* 헤더의 로고를 누르면 방에서 나와 여행 목록으로 돌아갑니다. */
async function goHome() {
  if (mode !== "shared") return;
  if (draft && draft.picks.length && !modalView) { modalView = "home"; render(); return; }
  if (roomChannel && sb) { try { sb.removeChannel(roomChannel); } catch (e) {} roomChannel = null; }
  roomId = null; roomCode = null; votersLoaded = false;
  S.meta = null; S.places = []; S.voters = []; S.ballots = [];
  draft = null; dateSel = null; editingDates = false;
  tagEditId = null; tagDraft = []; tagText = ""; search = ""; modalView = null;
  identified = false; showHeat = false; showPlaces = false; titleEdit = false; viewStep = null;
  location.hash = "";
  await fetchRooms();
  render();
}

async function attachRoom(code, id) {
  roomCode = code; roomId = id; votersLoaded = false;
  identified = false;   // 같은 방이라도 들어올 때마다 이름부터 확인합니다
  showHeat = false; showPlaces = false; titleEdit = false; viewStep = null;
  sb = baseClient({ "x-room-code": code });
  await sb.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  sb.realtime.setAuth(session.access_token);
  location.hash = "#" + code;
  await fetchRoom(); await fetchPlaces(); await fetchVoters();
  subscribeRoom(); schedule();
}

/* 방 목록. code 는 RLS 게이트용으로만 남아 있고 화면에는 나오지 않습니다. */
async function fetchRooms() {
  if (mode !== "shared") return;
  var r = await authClient.from("rooms").select("id,code,title,year,created_at,delete_code,deleted_at")
    .order("created_at", { ascending: false });
  var all = r.data || [];
  roomList = all.filter(function (x) { return !x.deleted_at; });
  trashRooms = all.filter(function (x) { return !!x.deleted_at; });
  schedule();
}

async function createRoom(title, year) {
  title = String(title || "").trim().slice(0, 24);
  year = Number(year) || newRoomYear;
  if (!title) title = String(year).slice(2) + "년도 여행";
  if (!/^[0-9]{4}$/.test(newRoomCode4)) { say("삭제 코드를 숫자 4자리로 정해 주세요."); return; }
  var code = makeCode();
  var client = baseClient({ "x-room-code": code });
  await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  var r = await client.from("rooms")
    .insert({ code: code, title: title, year: year, delete_code: newRoomCode4 })
    .select("id").single();
  if (r.error) { say(writeError(r.error)); return; }
  await attachRoom(code, r.data.id);
}

/* 삭제 코드가 맞는지. 코드가 없는 옛 방은 이름 옆에서 먼저 정하게 안내합니다. */
function codeOk(expected) {
  if (!expected) return "none";
  return String(codeDraft).trim() === String(expected) ? "ok" : "bad";
}

async function runGuarded() {
  if (!guardAction) return;
  var a = guardAction;
  var expected;
  if (a.kind === "delroom" || a.kind === "purgeroom") {
    // 지운 방은 휴지통 목록에 있습니다
    var row = roomList.concat(trashRooms).filter(function (r) { return r.code === a.code; })[0];
    expected = row ? row.delete_code : "";
  } else {
    expected = M().delete_code || "";
  }
  var st = codeOk(expected);
  if (st === "none") { say("이 여행은 삭제 코드가 없어요. 여행 이름 옆 '이름·코드'에서 먼저 정해 주세요."); return; }
  if (st === "bad") { say("삭제 코드가 맞지 않아요."); return; }
  guardAction = null; codeDraft = ""; modalView = null;
  if (a.kind === "delroom") await deleteRoom(a.code);
  else if (a.kind === "purgeroom") await purgeRoom(a.code);
  else if (a.kind === "clearvotes") { await clearRound(M().round); await fetchBallots(); say("표를 휴지통으로 옮겼어요. 되돌릴 수 있습니다."); }
  render();
}

async function deleteRoom(code) {
  if (!code) return;
  var client = baseClient({ "x-room-code": code });
  await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  var r = await client.from("rooms").update({ deleted_at: new Date().toISOString() }).eq("code", code);
  delTarget = null;
  if (r.error) { say(writeError(r.error)); return; }
  await fetchRooms();
  say("휴지통으로 옮겼어요. 되돌릴 수 있습니다.");
  render();
}

async function restoreRoom(code) {
  var client = baseClient({ "x-room-code": code });
  await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  var r = await client.from("rooms").update({ deleted_at: null }).eq("code", code);
  if (r.error) { say(writeError(r.error)); return; }
  await fetchRooms();
  say("되돌렸어요.");
  render();
}

async function purgeRoom(code) {
  var client = baseClient({ "x-room-code": code });
  await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  var r = await client.from("rooms").delete().eq("code", code);
  if (r.error) { say(writeError(r.error)); return; }
  await fetchRooms();
  say("영구히 지웠어요.");
  render();
}

async function joinRoomByCode(code) {
  code = String(code || "").trim().toUpperCase();
  if (code.length < 4) return;
  var client = baseClient({ "x-room-code": code });
  await client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  var r = await client.from("rooms").select("id").eq("code", code).maybeSingle();
  if (r.error || !r.data) { say("그 방을 찾을 수 없어요."); return; }
  await attachRoom(code, r.data.id);
}

async function initStore() {
  if (!CONFIGURED) { mode = "local"; localLoad(); schedule(); return; }
  try {
    await ensureSession();
    mode = "shared";
    var hash = (location.hash || "").replace(/^#\/?/, "").trim().toUpperCase();
    if (hash) await joinRoomByCode(hash);
    if (!roomId) await fetchRooms();
  } catch (e) { mode = "local"; localLoad(); }
  schedule();
}

/* ============================================================
   5. 집계
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

/* 날짜별로 가능한 사람 이름 */
function dateNames() {
  var m = {};
  S.voters.forEach(function (v) {
    voterDates(v).forEach(function (d) { (m[d] = m[d] || []).push(v.name); });
  });
  return m;
}

/* 날짜 집계 — 그 날 가능한 사람 수 */
function dateCounts() {
  var c = {};
  S.voters.forEach(function (v) { voterDates(v).forEach(function (d) { c[d] = (c[d] || 0) + 1; }); });
  return c;
}
function bestDates() {
  var c = dateCounts(), keys = Object.keys(c);
  if (!keys.length) return { max: 0, dates: [] };
  var max = 0;
  keys.forEach(function (k) { if (c[k] > max) max = c[k]; });
  return { max: max, dates: keys.filter(function (k) { return c[k] === max; }).sort() };
}

/* ============================================================
   6. 코멘트 변환
   ============================================================ */
function convert(placeId) {
  var raw = (draft.raw[placeId] || "").trim();
  if (!raw) return;
  if (chars(raw) > COMMENT_MAX) {
    draft.status[placeId] = "error";
    draft.err[placeId] = "원문이 " + COMMENT_MAX + "자를 넘었어요. 줄여 주세요.";
    render(); return;
  }
  var out = window.TV.tone.translatorize(raw);
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
    var done = draft.status[id] === "ready" || draft.status[id] === "raw";
    if (!raw && !done) { bad.push(id); return; }      // 코멘트는 필수
    if (chars(raw) > COMMENT_MAX) { bad.push(id); return; }
    if (!done) bad.push(id);
  });
  return bad;
}
function canSubmit() { return draft && draft.picks.length > 0 && draftBlocked().length === 0; }

/* ============================================================
   8. actions
   ============================================================ */
function say(msg) { toast = msg; render(); setTimeout(function () { if (toast === msg) { toast = ""; render(); } }, 2800); }

/* 명단에 있는 이름이면 그 사람으로 이어 갑니다. 없으면 새 참가자로 시작. */
function identifyAs(name) {
  name = String(name || "").trim().slice(0, 12);
  if (!name) { say("이름을 적어 주세요."); return; }
  var hit = null;
  for (var i = 0; i < S.voters.length; i++) {
    if (S.voters[i].name.replace(/\s/g, "") === name.replace(/\s/g, "")) { hit = S.voters[i]; break; }
  }
  if (hit) {
    me.id = hit.client_id; me.name = hit.name;
    LS.set("tv_cid", me.id); LS.set("tv_name", me.name);
  } else {
    me.id = uid(); me.name = name;
    LS.set("tv_cid", me.id); LS.set("tv_name", me.name);
    startDatePick();
  }
  identified = true;
  var r = reachedStep();
  viewStep = (r !== liveStep()) ? r : null;
  render();
}

function startDatePick() {
  var v = myVoter();
  dateSel = new Set(voterDates(v));
  vacDays = voterVac(v) == null ? "" : String(voterVac(v));
  return dateSel;
}
function vacNum() { var n = parseInt(vacDays, 10); return (n > 0 && n <= 60) ? n : null; }

async function joinAsName(name) {
  name = String(name || "").trim().slice(0, 12);
  if (!name) { say("이름을 적어 주세요."); return; }
  if (!dateSel || dateSel.size === 0) { say("가능한 날짜를 최소 하루는 골라 주세요."); return; }
  ensureCid(); me.name = name; LS.set("tv_name", name);
  var v = myVoter();
  await store.setVoter({
    client_id: me.id, name: name,
    rounds: (v && v.rounds) || {},
    dates: Array.from(dateSel).sort(),
    vacation_days: vacNum()
  });
  if (mode === "local" && !S.meta) await store.setMeta({});
  editingDates = false; dateSel = null;
  render();
}

async function saveDatesOnly() {
  var v = myVoter();
  if (!v) { editingDates = false; render(); return; }
  if (!dateSel || dateSel.size === 0) { say("최소 하루는 골라 주세요."); return; }
  await store.setVoter({ client_id: me.id, name: v.name, rounds: v.rounds || {}, dates: Array.from(dateSel).sort(), vacation_days: vacNum() });
  editingDates = false; dateSel = null; viewStep = null;
  render();
}

async function addDestination(dest) {
  if (S.places.length >= 24) { say("여행지는 24곳까지 넣을 수 있어요."); return; }
  if (S.places.some(function (p) { return p.name === dest.ko; })) { say("이미 올라와 있는 곳이에요."); return; }
  await store.addPlace({
    name: dest.ko, note: "", added_by: me.name, sort: Date.now(),
    country: dest.c, city: dest.city, region: dest.r,
    lat: dest.lat, lon: dest.lon, hours: dest.h, direct: !!dest.d,
    price_min: dest.p[0], price_max: dest.p[1]
  });
  search = "";
  var f = document.querySelector('[data-keep="destsearch"]');
  if (f) f.value = "";
  var added = S.places.filter(function (p) { return p.name === dest.ko; })[0];
  if (added) openTags(added.id); else render();
}

async function addCustomPlace() {
  var el = document.querySelector('[data-keep="destsearch"]');
  var name = el ? el.value.trim() : "";
  if (!name) { say("이름을 적어 주세요."); return; }
  if (S.places.some(function (p) { return p.name === name; })) { say("이미 올라와 있는 곳이에요."); return; }
  await store.addPlace({ name: name.slice(0, 40), note: "", added_by: me.name, sort: Date.now() });
  search = ""; if (el) el.value = "";
  render();
}

async function startVote() {
  if (S.places.length < 2) { say("여행지를 2곳 이상 올려 주세요."); return; }
  // 이미 낸 표는 그대로 둡니다. 고치고 싶은 사람은 각자 '내 표 고치기' 를 씁니다.
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
  var newId = await store.addBallot({ round: round, entries: shuffle(entries) });
  if (!newId) return;
  var v = myVoter() || { client_id: me.id, name: me.name, rounds: {}, dates: [] };
  var rounds = Object.assign({}, v.rounds || {}); rounds["r" + round] = true;
  await store.setVoter({ client_id: me.id, name: v.name || me.name, rounds: rounds, dates: voterDates(v), vacation_days: voterVac(v) });
  modalView = null; draft = null;
  if (mode === "local") modalView = "handoff";
  render();
}

/* 지금 화면에서 한 단계 뒤로. 데이터를 지우지 않고 단계만 되돌립니다.
   특히 result -> vote 는 "결과를 너무 일찍 열었다" 를 되돌리는 통로입니다.
   되돌아가면 아직 투표 못 한 사람과 새로 들어온 사람이 다시 참여할 수 있습니다. */
function backTarget() {
  if (mode !== "shared" && mode !== "local") return null;
  if (needsRoom() || needsJoin() || editingDates) return null;
  var m = M();
  if (m.phase === "vote") return m.round === 1 ? { phase: "lobby" } : { phase: "choose" };
  if (m.phase === "result") return { phase: "vote" };
  if (m.phase === "choose") return { phase: "result" };
  if (m.phase === "wheel") return { phase: "choose" };
  if (m.phase === "done") return m.tiebreak === "wheel" ? { phase: "wheel" } : { phase: "result" };
  return null;
}

async function goBack() {
  var t = backTarget();
  if (!t) return;
  viewStep = null;
  var patch = { phase: t.phase };
  if (t.phase !== "done") patch.winner = null;
  if (t.phase === "choose" || t.phase === "result") patch.spin = null;
  await store.setMeta(patch);
  if (mode === "shared") await fetchBallots();
  render();
}

/** 한 라운드의 표와 '투표함' 표시를 지웁니다. 참가자·날짜·여행지는 그대로. */
async function clearRound(round) {
  if (mode === "shared") {
    var now = new Date().toISOString();
    await sb.from("ballots").update({ deleted_at: now })
      .eq("room_id", roomId).eq("round", round).is("deleted_at", null);
  } else {
    S.ballots = S.ballots.filter(function (b) { return b.round !== round; });
  }
  for (var j = 0; j < S.voters.length; j++) {
    var v = S.voters[j];
    if (!hasVoted(v, round)) continue;
    var rounds = Object.assign({}, v.rounds || {});
    delete rounds["r" + round];
    await store.setVoter({ client_id: v.client_id, name: v.name, rounds: rounds, dates: voterDates(v), vacation_days: voterVac(v) });
  }
  if (mode === "shared") await fetchBallots(); else localSave();
}

/* 낸 표를 회수해 고치기. 내 표 하나만 지우고 이전 선택을 초안으로 되살립니다.
   다른 사람 표는 건드리지 않습니다. */
async function editMyBallot() {
  var typed = String(editName || "").trim().replace(/\s/g, "");
  if (!typed) { say("본인 이름을 적어 주세요."); return; }
  if (typed !== String(me.name || "").replace(/\s/g, "")) {
    say("지금 들어와 있는 이름(" + me.name + ")과 달라요.");
    return;
  }
  editName = "";
  var round = M().round;
  var b = myBallot(round);
  if (!b) { say("낸 표를 찾지 못했어요. 새로고침한 뒤 다시 시도해 주세요."); return; }
  var entries = (b.entries || []).slice();

  await store.delBallot(b.id);
  var v = myVoter();
  if (v) {
    var rounds = Object.assign({}, v.rounds || {});
    delete rounds["r" + round];
    await store.setVoter({ client_id: me.id, name: v.name, rounds: rounds,
      dates: voterDates(v), vacation_days: voterVac(v) });
  }
  resetDraft(round);
  entries.forEach(function (e) {
    if (!placeById(e.place)) return;
    draft.picks.push(e.place);
    if (e.comment) {
      draft.raw[e.place] = e.comment;
      draft.ai[e.place] = e.comment;
      draft.status[e.place] = "ready";
    }
  });
  modalView = null;
  say("표를 되돌렸어요. 고쳐서 다시 제출해 주세요.");
  render();
}

/* 초기화한 표를 되살립니다. 표시만 지워 뒀으므로 그대로 돌아옵니다. */
/* 휴지통을 완전히 비웁니다. 여기서만 실제로 DELETE 합니다. */
async function emptyTrash() {
  if (mode !== "shared") { trashPlaces = []; render(); return; }
  var n = trashPlaces.length;
  for (var i = 0; i < trashPlaces.length; i++) {
    await sb.from("places").delete().eq("id", trashPlaces[i].id);
  }
  var r = await sb.from("ballots").delete()
    .eq("room_id", roomId).not("deleted_at", "is", null).select("id");
  var m = (r.data || []).length;
  modalView = null;
  await fetchPlaces(); await fetchBallots();
  say("휴지통을 비웠어요. (여행지 " + n + "곳, 표 " + m + "장)");
  render();
}

async function restoreBallots() {
  var round = M().round;
  if (mode !== "shared") { say("이 모드에서는 되돌릴 수 없어요."); return; }
  var r = await sb.from("ballots").select("id,client_id")
    .eq("room_id", roomId).eq("round", round).not("deleted_at", "is", null);
  var rows = r.data || [];
  if (!rows.length) { say("되돌릴 표가 없어요."); return; }
  await sb.from("ballots").update({ deleted_at: null })
    .eq("room_id", roomId).eq("round", round).not("deleted_at", "is", null);
  // 투표함 표시도 되살립니다
  for (var i = 0; i < rows.length; i++) {
    var owner = rows[i].client_id;
    if (!owner) continue;
    var v = S.voters.filter(function (x) { return x.client_id === owner; })[0];
    if (!v || hasVoted(v, round)) continue;
    var rounds = Object.assign({}, v.rounds || {}); rounds["r" + round] = true;
    await sb.from("voters").upsert(
      { room_id: roomId, client_id: v.client_id, name: v.name, rounds: rounds,
        dates: voterDates(v), vacation_days: voterVac(v) },
      { onConflict: "room_id,client_id" });
  }
  await fetchVoters(); await fetchBallots();
  say(rows.length + "장을 되돌렸어요.");
  render();
}

async function openResult() {
  var m = M();
  var left = S.voters.length - votedCount(m.round);
  if (left > 0 && modalView !== "openresult") { modalView = "openresult"; render(); return; }
  modalView = null;
  await store.setMeta({ phase: "result" });
  if (mode === "shared") await fetchBallots();
}
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

function switchPerson() {
  LS.del(roomKey());
  identified = false;
  draft = null; dateSel = null; editingDates = false; modalView = null;
  render();
}

function nextPerson() {
  LS.del("tv_cid"); LS.del("tv_name");
  me = { id: "", name: "" };
  draft = null; modalView = null; dateSel = null; editingDates = false;
  render();
}

async function copyLink() {
  var url = location.origin + location.pathname + "#" + roomCode;
  try { await navigator.clipboard.writeText(url); say("링크를 복사했어요. 단톡방에 붙여넣으세요."); }
  catch (e) { say("복사가 안 됐어요. 주소창의 링크를 직접 복사해 주세요."); }
}

/* ============================================================
   9. 캘린더 (2027)
   ============================================================ */
function calHTML() {
  var C = window.TV.cal;
  var head = C.WEEKDAYS.map(function (w, i) {
    return '<span class="' + (i === 0 || i === 6 ? "we" : "") + '">' + w + "</span>";
  }).join("");
  var body = C.months(M().year || C.YEAR).map(function (mo) {
    var cells = "", i, j;
    for (i = 0; i < mo.lead; i++) cells += '<div class="cal-day pad"></div>';
    mo.days.forEach(function (d) {
      cells += '<div class="cal-day' + (dateSel && dateSel.has(d) ? " on" : "") +
        '" data-d="' + d + '">' + Number(d.slice(8)) + "</div>";
    });
    var rest = (mo.lead + mo.days.length) % 7;
    if (rest) for (j = rest; j < 7; j++) cells += '<div class="cal-day pad"></div>';
    return '<div class="cal-month"><div class="cal-label">' + mo.label + '</div><div class="cal-grid">' + cells + "</div></div>";
  }).join("");
  return '<div class="cal"><div class="cal-head">' + head + "</div>" +
    '<div class="cal-scroll">' + body + "</div></div>" +
    '<div class="cal-picked" id="calpicked">' + esc(datePickedText()) + "</div>";
}

function datePickedText() {
  if (!dateSel || !dateSel.size) return "아직 고른 날짜가 없어요.";
  return dateSel.size + "일 선택 · " + window.TV.cal.summarize(Array.from(dateSel));
}

function paintDates() {
  $$(".cal-day[data-d]").forEach(function (el) {
    el.classList.toggle("on", !!(dateSel && dateSel.has(el.dataset.d)));
    el.classList.remove("pre");
  });
  var p = $("#calpicked");
  if (p) p.textContent = datePickedText();
  $("#dock").innerHTML = renderDock();
}

/* 드래그 선택.
   마우스는 누르는 즉시, 터치는 220ms 길게 누른 뒤에 시작합니다.
   그래야 캘린더를 세로로 스크롤하는 평범한 동작을 막지 않습니다. */
var drag = null;

function previewRange(a, b) {
  drag.preview = window.TV.cal.range(a, b);
  var set = {};
  drag.preview.forEach(function (d) { set[d] = 1; });
  $$(".cal-day[data-d]").forEach(function (el) { el.classList.toggle("pre", !!set[el.dataset.d]); });
}

document.addEventListener("pointerdown", function (e) {
  if (!dateSel) return;
  var el = e.target.closest ? e.target.closest(".cal-day[data-d]") : null;
  if (!el) return;
  var d = el.dataset.d;
  drag = { start: d, mode: dateSel.has(d) ? "remove" : "add", active: false, preview: [d] };
  if (e.pointerType === "mouse") { drag.active = true; previewRange(d, d); }
  else { drag.timer = setTimeout(function () { if (drag) { drag.active = true; previewRange(drag.start, drag.start); } }, 220); }
});

document.addEventListener("pointermove", function (e) {
  if (!drag) return;
  var el = document.elementFromPoint(e.clientX, e.clientY);
  el = el && el.closest ? el.closest(".cal-day[data-d]") : null;
  if (!drag.active) {
    // 길게 누르기 전에 손가락이 다른 칸으로 갔다면 스크롤 의도로 봅니다.
    if (el && el.dataset.d !== drag.start) { clearTimeout(drag.timer); drag = null; }
    return;
  }
  if (el) previewRange(drag.start, el.dataset.d);
});

document.addEventListener("touchmove", function (e) {
  if (drag && drag.active) e.preventDefault();
}, { passive: false });

function endDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  var list = drag.active ? drag.preview : [drag.start];
  var mode = drag.mode;
  list.forEach(function (d) { if (mode === "add") dateSel.add(d); else dateSel.delete(d); });
  drag = null;
  paintDates();
}
document.addEventListener("pointerup", endDrag);
document.addEventListener("pointercancel", function () {
  if (drag) { clearTimeout(drag.timer); drag = null; paintDates(); }
});

/* ============================================================
   10. 지도
   ============================================================ */
var _mapCache = { key: null, html: "" };

function mapHTML(places) {
  var Mp = window.TV.map;
  var key = places.map(function (p) { return p.country || p.name; }).sort().join(",");
  if (_mapCache.key === key) return _mapCache.html;

  var paths = Mp.countryPaths(), on = {};
  places.forEach(function (p) { if (p.country) on[p.country] = 1; });

  var lands = Object.keys(paths).map(function (iso) {
    return '<path class="land' + (on[iso] ? " on" : "") + '" d="' + paths[iso] + '"/>';
  }).join("");

  var routes = "", dots = "";
  places.forEach(function (p) {
    if (p.lat == null || p.lon == null) return;
    Mp.arc(ORIGIN, p).forEach(function (d) { routes += '<path class="route" d="' + d + '"/>'; });
    dots += '<circle class="dot" cx="' + Mp.px(p.lon).toFixed(1) + '" cy="' + Mp.py(p.lat).toFixed(1) + '" r="2.6"/>';
  });
  dots += '<circle class="dot home" cx="' + Mp.px(ORIGIN.lon).toFixed(1) + '" cy="' + Mp.py(ORIGIN.lat).toFixed(1) + '" r="3"/>';

  var html = '<div class="mapwrap"><svg viewBox="0 0 ' + Mp.W + " " + Mp.H + '" aria-label="세계지도">' +
    lands + routes + dots + "</svg></div>";
  _mapCache = { key: key, html: html };
  return html;
}

/* ============================================================
   11. 보딩패스 카드
   ============================================================ */
function passHTML(p, opts) {
  opts = opts || {};
  var F = window.TV.fmt;
  var code = (p.country || "").toUpperCase() || "—";
  return '<div class="pass' + (opts.cls || "") + (opts.selected ? " sel" : "") + '">' +
    (opts.tick ? '<span class="tick">✓</span>' : "") +
    '<div class="pass-top">' +
      '<div class="pass-code">' + esc(ORIGIN.code) + " → " + esc(code) +
        (p.region ? " · " + esc(p.region) : "") + "</div>" +
      '<div class="pass-name">' + esc(p.name) + "</div>" +
      (p.city ? '<div class="pass-city">' + esc(p.city) + " 기준</div>" : "") +
    "</div><div class=\"pass-perf\"></div>" +
    '<div class="pass-body">' +
      '<div class="cell"><div class="k">비행시간</div><div class="v">' +
        (p.hours != null ? esc(F.hours(p.hours)) + " <small>" + (p.direct ? "직항" : "경유") + "</small>" : "—") + "</div></div>" +
      '<div class="cell"><div class="k">왕복 항공권</div><div class="v">' +
        (p.price_min != null ? esc(F.won([p.price_min, p.price_max])) : "—") + "</div></div>" +
    "</div></div>";
}


/* ============================================================
   태그 — 여행지에 붙이는 공개 메모. 투표 때 다는 익명 코멘트와는 별개입니다.
   ============================================================ */
function placeTags(p) { return (p && Array.isArray(p.tags)) ? p.tags : []; }

function normTag(t) {
  return String(t || "").replace(/^#+/, "").replace(/[s,]+/g, "").slice(0, 12).trim();
}

function openTags(id) {
  var p = placeById(id);
  tagEditId = id;
  tagDraft = placeTags(p).slice();
  tagText = "";
  render();
}

function addTagFromInput(raw) {
  var t = normTag(raw == null ? tagText : raw);
  if (!t) return false;
  if (tagDraft.length >= TAG_MAX) { say("태그는 " + TAG_MAX + "개까지예요."); return false; }
  if (tagDraft.indexOf(t) >= 0) { tagText = ""; return true; }
  tagDraft.push(t);
  tagText = "";
  return true;
}

async function saveTags() {
  if (!tagEditId) return;
  var id = tagEditId, tags = tagDraft.slice();
  var pending = normTag(tagText);
  if (pending && tags.indexOf(pending) < 0 && tags.length < TAG_MAX) tags.push(pending);
  tagEditId = null; tagDraft = []; tagText = "";
  await store.updatePlace(id, { tags: tags });
  render();
}

function tagEditorHTML(id) {
  var chips = tagDraft.map(function (t, i) {
    return '<span class="tag-chip on">#' + esc(t) +
      '<button data-act="rmtag" data-i="' + i + '" aria-label="삭제">×</button></span>';
  }).join("");
  var used = {};
  tagDraft.forEach(function (t) { used[t] = 1; });
  var sug = TAG_SUGGEST.filter(function (t) { return !used[t]; }).slice(0, 8).map(function (t) {
    return '<button class="tag-sug" data-act="sugtag" data-t="' + esc(t) + '">#' + esc(t) + "</button>";
  }).join("");

  return '<div class="tag-edit">' +
    '<div class="eyebrow">태그 · ' + tagDraft.length + " / " + TAG_MAX + "</div>" +
    (chips ? '<div class="tagrow">' + chips + "</div>" : '<p class="muted">아직 없어요.</p>') +
    '<input class="field" data-keep="taginput" data-taginput="1" maxlength="13" ' +
      'placeholder="태그 입력 후 엔터 (예: 맛집)" autocomplete="off" value="' + esc(tagText) + '">' +
    (sug ? '<div class="tagrow">' + sug + "</div>" : "") +
    '<div class="btn-row"><button class="btn sm red" data-act="savetags">저장</button>' +
    '<button class="btn sm ghost" data-act="canceltags">취소</button></div></div>';
}

function tagsLine(p) {
  var t = placeTags(p);
  if (!t.length) return "";
  return '<div class="tagrow">' + t.map(function (x) {
    return '<span class="tag-chip">#' + esc(x) + "</span>";
  }).join("") + "</div>";
}

/* ============================================================
   12. render
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
  { k: "join", label: "01 참가·날짜" },
  { k: "lobby", label: "02 여행지" },
  { k: "vote1", label: "03 1차" },
  { k: "final", label: "04 결선" },
  { k: "done", label: "05 확정" }
];
function stepKey() {
  if (viewStep) return STEPS[viewStep - 1].k;
  if (needsRoom() || needsJoin() || editingDates) return "join";
  var m = M();
  if (m.phase === "lobby") return "lobby";
  if (m.phase === "done") return "done";
  if (m.phase === "vote" || m.phase === "result") return m.round === 1 ? "vote1" : "final";
  return "final";
}
function needsRoom() { return mode === "shared" && !roomId; }
/* 방에 들어오면 먼저 "누구세요" 를 묻습니다.
   이미 참가자 명단에 있는 이름이면 그 사람으로 이어서 보고 (다른 폰에서 들어와도 됨),
   처음 보는 이름이면 날짜부터 고르는 전체 흐름으로 보냅니다. */
/* 헤더 숫자로 이동. 방 단계는 건드리지 않고 내 화면만 바꿉니다. */
function goStep(n) {
  n = Number(n);
  if (n < 1 || n > Math.max(reachedStep(), 1)) return;
  viewStep = (n === liveStep()) ? null : n;
  editingDates = (n === 1);
  if (editingDates) startDatePick(); else { dateSel = null; }
  tagEditId = null; modalView = null;
  render();
}

/* 한 라운드를 되돌아보는 읽기 전용 화면 */
function viewRoundSummary(round) {
  var counts = {}, n = 0;
  S.places.forEach(function (p) { counts[p.id] = 0; });
  S.ballots.forEach(function (b) {
    if (b.round !== round) return;
    n++;
    (b.entries || []).forEach(function (e) { if (counts[e.place] != null) counts[e.place]++; });
  });
  var rows = S.places.map(function (p) { return { id: p.id, n: counts[p.id], name: p.name }; })
    .filter(function (r) { return r.n > 0; })
    .sort(function (a, b) { return b.n - a.n || a.name.localeCompare(b.name, "ko"); });

  if (!rows.length) {
    return stepBanner() +
      '<div class="panel stack"><div class="eyebrow">' + roundLabel(round) + "</div>" +
      '<h1 class="title">아직 표가 없어요</h1>' +
      '<p class="lede">이 단계는 아직 진행되지 않았습니다.</p></div>';
  }
  var maxN = rows[0].n;
  var rank = rows.map(function (r, i) {
    var lead = r.n === maxN;
    return '<div class="rrow' + (lead ? " lead" : "") + '"><div class="rpos">' + pad2(i + 1) + "</div>" +
      '<div class="rname">' + esc(r.name) + '</div><div class="rnum">' + r.n + "표</div></div>" +
      '<div class="bar"><span style="width:' + Math.round(r.n / maxN * 100) + "%;background:" +
      (lead ? "var(--accent)" : "var(--ink-2)") + '"></span></div>';
  }).join("");

  return stepBanner() +
    '<div class="stack"><div><div class="eyebrow">' + roundLabel(round) + " 기록 · " + n + "명 참여</div>" +
    '<h1 class="title">이렇게 나왔어요</h1></div></div>' +
    '<div class="panel"><div class="stack-sm">' + rank + "</div></div>" +
    commentsPanel(round);
}
function roundLabel(round) { return round === 1 ? "1차 투표" : "결선 " + (round - 1) + "차"; }

/* 지금 보고 있는 게 현재 단계가 아닐 때 알려 줍니다 */
function stepBanner() {
  if (!viewStep || viewStep === liveStep()) return "";
  return '<div class="banner"><span class="mk">지난 단계</span>' +
    '<span style="flex:1">지금 보고 있는 건 <b>' + STEPS[viewStep - 1].label + '</b> 기록이에요.</span>' +
    '<button class="btn sm" data-act="golive">현재 단계로</button></div>';
}

/* 결과를 열어도 아직 투표 안 한 사람은 계속 투표할 수 있습니다.
   나중에 들어온 사람도 마찬가지고, 표가 들어오면 결과가 같이 바뀝니다. */
function canStillVote() {
  var m = M();
  if (m.phase !== "result") return false;
  var v = myVoter();
  return !!v && !hasVoted(v, m.round);
}

function needsIdentify() {
  if (mode === "shared" && !votersLoaded) return false;
  if (needsRoom()) return false;
  return !identified;
}

/* 날짜가 있어야 참가 완료입니다. 예전 이름이 브라우저에 남아 있다고
   날짜 화면을 건너뛰면 빈 날짜로 등록돼 버립니다. */
function needsDates() {
  if (mode === "shared" && !votersLoaded) return false;
  if (needsRoom() || needsIdentify()) return false;
  var v = myVoter();
  return !v || voterDates(v).length === 0;
}

function needsJoin() { return needsIdentify() || needsDates(); }

function render() {
  if (drag && drag.active) return;   // 드래그 중엔 DOM을 갈아엎지 않습니다
  captureFocus();
  var m = M();

  $("#who").innerHTML = mode === "connecting" ? "연결 중"
    : mode === "local" ? "이 기기 전용"
    : !roomId ? "방 없음"
    : (me.name ? esc(me.name) : "이름 없음") + " · " + S.voters.length + "명";

  var bb = document.getElementById("backbtn");
  if (bb) { if (backTarget()) bb.removeAttribute("hidden"); else bb.setAttribute("hidden", ""); }

  var sk = stepKey(), cur = 0;
  STEPS.forEach(function (st, i) { if (st.k === sk) cur = i; });
  var reach = needsRoom() ? 0 : Math.max(reachedStep(), 1);
  $("#steps").innerHTML = STEPS.map(function (st, i) {
    var n = i + 1, can = n <= reach && !needsIdentify();
    var cls = (i === cur ? "on" : (i < cur ? "past" : "")) + (can ? " go" : "");
    return '<li class="' + cls + '">' + (can
      ? '<button data-act="gostep" data-n="' + n + '">' + st.label + "</button>"
      : st.label) + "</li>";
  }).join("");

  if (wheelBusy && m.phase === "wheel") return;

  var html = "";
  if (mode === "connecting") html = viewConnecting();
  else if (needsRoom()) html = viewRoomEntry();
  else if (mode === "shared" && !votersLoaded) html = viewConnecting();
  else if (editingDates) html = viewDates();
  else if (needsIdentify()) html = viewIdentify();
  else if (needsDates()) html = viewJoin();
  else if (viewStep && viewStep !== liveStep()) {
    if (viewStep === 1) html = viewDates();
    else if (viewStep === 2) html = stepBanner() + viewLobby();
    else if (viewStep === 3) html = viewRoundSummary(1);
    else if (viewStep === 4) html = viewRoundSummary(M().round > 1 ? M().round : 2);
    else html = stepBanner() + viewDone();
  }
  else if (m.phase === "lobby") html = viewLobby();
  else if (m.phase === "vote") html = viewVote();
  else if (m.phase === "result") html = canStillVote() ? viewVote() : viewResult();
  else if (m.phase === "choose") html = viewChoose();
  else if (m.phase === "wheel") html = viewWheel();
  else if (m.phase === "done") html = viewDone();
  $("#main").innerHTML = html;

  $("#dock").innerHTML = renderDock();
  $("#foot").innerHTML = renderFoot();
  $("#modal").innerHTML = renderModal();

  restoreFocus();
  if (m.phase === "wheel" && !needsRoom() && !needsJoin() && !editingDates) afterWheel();
}

/* 예전에는 여기서 참가자를 자동 등록했지만, 날짜 없이 등록되는 통로였습니다.
   이제 등록은 참가 화면(joinAsName)에서만 일어납니다. */

function toastHTML() {
  return toast ? '<div class="notice"><span class="ic">!</span><span>' + esc(toast) + "</span></div>" : "";
}
function modeBanner() {
  if (mode === "local") {
    return '<div class="banner"><span class="mk">단말 모드</span><span>' +
      (CONFIGURED ? "서버에 연결하지 못했어요. 지금은 <b>이 기기에만</b> 저장됩니다."
                  : "아직 서버 설정 전이라 <b>이 기기에만</b> 저장돼요. 폰을 돌려가며 한 명씩 쓰면 됩니다.") +
      "</span></div>";
  }
  return '<div class="banner"><span class="mk">실시간</span><span>같은 링크를 연 사람 모두에게 바로 반영돼요.</span></div>';
}
function shareCard() {
  if (mode !== "shared" || !roomId) return "";
  var m = M();
  if (titleEdit) {
    return '<div class="stack-sm"><div class="eyebrow">여행 이름</div>' +
      '<input class="field" data-keep="titleinput" data-titleinput="1" maxlength="24" ' +
        'placeholder="예: 27년도 여행" autocomplete="off" value="' + esc(titleDraft) + '">' +
      '<div class="eyebrow">삭제 코드 (숫자 4자리)</div>' +
      '<input class="field" data-keep="newcode" data-newcode="1" inputmode="numeric" maxlength="4" ' +
        'placeholder="' + (m.delete_code ? "지금 설정됨 · 바꾸려면 입력" : "아직 없음 · 정해 주세요") + '" ' +
        'autocomplete="off" value="' + esc(newRoomCode4) + '">' +
      '<p class="muted">여행을 지우거나 표를 초기화할 때 물어봅니다.</p>' +
      '<div class="btn-row"><button class="btn sm red" data-act="savetitle">저장</button>' +
      '<button class="btn sm ghost" data-act="canceltitle">취소</button></div></div>';
  }
  return '<div class="stack-sm"><div class="eyebrow">' + (m.year || window.TV.cal.YEAR) + " 여행</div>" +
    '<div class="codebox">' + esc(m.title || "여행") + "</div>" +
    '<div class="btn-row"><button class="btn block" data-act="copylink">링크 복사해서 단톡방에 뿌리기</button></div>' +
    '<button class="btn sm ghost" data-act="edittitle">이름·삭제코드 바꾸기</button>' +
    (m.delete_code ? "" : '<p class="muted">삭제 코드가 없어요. 실수로 날리는 걸 막으려면 정해 두세요.</p>') +
    "</div>";
}

async function saveTitle() {
  var t = String(titleDraft || "").trim().slice(0, 24);
  if (!t) { say("이름을 적어 주세요."); return; }
  var patch = { title: t };
  if (newRoomCode4) {
    if (!/^[0-9]{4}$/.test(newRoomCode4)) { say("삭제 코드는 숫자 4자리예요."); return; }
    patch.delete_code = newRoomCode4;
  }
  titleEdit = false; newRoomCode4 = "";
  await store.setMeta(patch);
  render();
}

function viewConnecting() {
  return '<div class="panel stack"><div class="eyebrow">Boarding</div><h1 class="title">연결하는 중</h1>' +
    '<p class="lede">서버에 붙는 중이에요. 연결이 안 되면 이 기기에서 폰을 돌려가며 쓰는 모드로 전환됩니다.</p></div>';
}

function viewRoomEntry() {
  var list = roomList.map(function (r) {
    return '<div class="res" style="padding:0">' +
      '<button class="res" style="border:0;flex:1" data-act="enterroom" data-code="' + esc(r.code) + '">' +
        '<span class="nm">' + esc(r.title || (r.year + "년도 여행")) + "</span>" +
        '<span class="rg">' + r.year + "</span></button>" +
      '<button class="btn sm ghost" style="margin-right:10px" data-act="askdelroom" data-code="' +
        esc(r.code) + '" data-t="' + esc(r.title || "") + '">삭제</button></div>';
  }).join("");

  var years = [2026, 2027, 2028, 2029].map(function (y) {
    return '<button class="btn sm' + (y === newRoomYear ? " red" : " ghost") + '" data-act="setyear" data-y="' + y + '">' + y + "</button>";
  }).join("");

  return toastHTML() +
    '<div class="stack"><div><div class="eyebrow">Start</div><h1 class="title">어느 여행이에요?</h1></div>' +
    '<p class="lede">이미 만들어진 여행이 있으면 골라서 들어오고, 없으면 새로 만드세요.</p></div>' +
    (roomList.length
      ? '<div class="stack-sm"><div class="eyebrow">진행 중인 여행</div><div class="results" style="border-radius:6px;border-top:2px solid var(--ink)">' + list + "</div></div>"
      : '<p class="muted" style="text-align:center;padding:6px 0">아직 만들어진 여행이 없어요.</p>') +
    (trashRooms.length
      ? '<div class="stack-sm"><button class="btn ghost block" data-act="toggletrash">' +
        (showTrash ? "휴지통 접기 ▲" : "휴지통 " + trashRooms.length + "개 ▼") + "</button>" +
        (showTrash
          ? '<div class="results" style="border-radius:6px;border-top:1.5px solid var(--line)">' +
            trashRooms.map(function (r) {
              return '<div class="res" style="padding:0">' +
                '<span class="nm" style="padding:11px 13px;flex:1">' + esc(r.title || "여행") + "</span>" +
                '<button class="btn sm" style="margin-right:6px" data-act="restoreroom" data-code="' + esc(r.code) + '">되돌리기</button>' +
                '<button class="btn sm ghost" style="margin-right:10px" data-act="askpurge" data-code="' + esc(r.code) + '" data-t="' + esc(r.title || "") + '">영구 삭제</button></div>';
            }).join("") + "</div>"
          : "") + "</div>"
      : "") +
    '<div class="panel stack-sm"><div class="eyebrow">새로 만들기</div>' +
    '<div class="btn-row">' + years + "</div>" +
    '<input class="field" data-keep="roomtitle" data-newtitle="1" maxlength="24" placeholder="' +
      String(newRoomYear).slice(2) + '년도 여행" autocomplete="off" value="' + esc(newRoomTitle) + '">' +
    '<p class="muted">고른 연도의 캘린더가 들어갑니다. 이름을 비우면 “' +
      String(newRoomYear).slice(2) + '년도 여행”으로 만들어져요.</p>' +
    '<div class="eyebrow" style="margin-top:4px">삭제 코드 (숫자 4자리)</div>' +
    '<input class="field" data-keep="newcode" data-newcode="1" inputmode="numeric" maxlength="4" ' +
      'placeholder="예: 1234" autocomplete="off" value="' + esc(newRoomCode4) + '">' +
    '<p class="muted">여행을 지우거나 표를 초기화할 때 물어봅니다. 실수로 날리는 걸 막는 용도예요. 친구들에게 알려 주세요.</p>' +
    '<button class="btn red block" data-act="createroom">이 여행 만들기</button></div>';
}

function viewIdentify() {
  var known = S.voters.map(function (v) {
    return '<button class="res" data-act="iam" data-n="' + esc(v.name) + '">' +
      '<span class="nm">' + esc(v.name) + "</span>" +
      '<span class="rg">' + voterDates(v).length + "일</span>" +
      '<span class="hr">' + (hasVoted(v, M().round) ? "투표함" : "투표 전") + "</span></button>";
  }).join("");

  return toastHTML() +
    '<div class="stack"><div><div class="eyebrow">' + esc(M().title || "여행") + "</div>" +
    '<h1 class="title">누구세요?</h1></div>' +
    '<p class="lede">이미 참여했다면 이름을 누르세요. 처음이면 아래에 이름을 적으면 됩니다.</p></div>' +
    (S.voters.length
      ? '<div class="stack-sm"><div class="eyebrow">참가자 ' + S.voters.length + "명</div>" +
        '<div class="results" style="border-radius:6px;border-top:2px solid var(--ink)">' + known + "</div></div>"
      : '<p class="muted" style="text-align:center;padding:6px 0">아직 참가자가 없어요.</p>') +
    '<div class="panel stack-sm"><div class="eyebrow">처음이라면</div>' +
    '<input class="field" data-keep="idname" maxlength="12" placeholder="이름 (예: 지수)" autocomplete="off" value="' + esc(me.name) + '">' +
    '<button class="btn red block" data-act="identify">' + (me.name ? esc(me.name) + ro(me.name) + " 시작하기" : "시작하기") + "</button></div>";
}

function viewJoin() {
  if (!dateSel) startDatePick();
  return toastHTML() +
    '<div class="stack"><div><div class="eyebrow">Step 01 · Passenger</div>' +
    '<h1 class="title">' + (me.name ? "가능한 날짜를<br>골라 주세요" : "이름과<br>가능한 날짜") + "</h1></div>" +
    '<p class="lede">이름은 누가 참여했는지 표시하는 데만 써요. <b>표와 코멘트는 이름과 연결되지 않습니다.</b></p></div>' +
    '<input class="field" data-keep="joinname" maxlength="12" placeholder="이름 (예: 지수)" value="' + esc(me.name) + '" autocomplete="off">' +
    '<div class="stack-sm"><div class="eyebrow">' + (M().year || window.TV.cal.YEAR) + '년 · 가능한 날짜를 모두 고르세요</div>' +
    '<p class="muted">탭하면 하루가 선택돼요. <b>꾹 눌렀다가 드래그</b>하면 여러 날을 한 번에 고를 수 있어요.</p>' +
    calHTML() + "</div>" + '<div class="panel stack-sm"><div class="eyebrow">휴가는 며칠까지</div>' +
    '<p class="muted">주말 빼고 <b>평일 기준</b>으로 최대 며칠 쓸 수 있는지 적어 주세요. 비워도 됩니다.</p>' +
    '<input class="field" data-keep="vacdays" type="number" inputmode="numeric" min="1" max="60" ' +
    'placeholder="예: 7" value="' + esc(vacDays) + '"></div>' + allDoneShortcut() + modeBanner();
}

function viewDates() {
  if (!dateSel) startDatePick();
  return toastHTML() + stepBanner() +
    '<div class="stack"><div><div class="eyebrow">내 날짜 수정</div><h1 class="title">가능한 날짜</h1></div>' +
    '<p class="lede">탭하면 하루, <b>꾹 눌렀다가 드래그</b>하면 여러 날을 한 번에 고를 수 있어요.</p></div>' +
    calHTML() + '<div class="panel stack-sm"><div class="eyebrow">휴가는 며칠까지</div>' +
    '<p class="muted">주말 빼고 <b>평일 기준</b>으로 최대 며칠 쓸 수 있는지 적어 주세요. 비워도 됩니다.</p>' +
    '<input class="field" data-keep="vacdays" type="number" inputmode="numeric" min="1" max="60" ' +
    'placeholder="예: 7" value="' + esc(vacDays) + '"></div>' + "";
}

function allDoneShortcut() {
  var m = M();
  if (m.phase !== "vote" || !S.voters.length) return "";
  if (votedCount(m.round) < S.voters.length) return "";
  return '<div class="panel stack-sm"><div class="eyebrow">' + S.voters.length + "명 모두 투표 완료</div>" +
    '<button class="btn red block" data-act="openresult">결과 열기</button></div>';
}

/* 결과·확정 화면에서도 여행지 정보를 보고 태그를 고칠 수 있게 합니다. */
function placesPanel(ids) {
  if (!ids.length) return "";
  return '<div class="stack"><div class="eyebrow">여행지 정보</div>' +
    ids.map(function (id) {
      var p = placeById(id);
      if (!p) return "";
      var editing = tagEditId === id;
      return '<div class="stack-sm">' + passHTML(p) +
        (editing ? tagEditorHTML(id) : tagsLine(p)) +
        (editing ? "" : '<div class="btn-row"><button class="btn sm ghost" data-act="opentags" data-id="' + id + '">' +
          (placeTags(p).length ? "태그 고치기" : "+ 태그 달기") + "</button></div>") +
        "</div>";
    }).join("") + "</div>";
}

/* 검색 결과만 따로 그립니다.
   입력할 때마다 화면 전체를 다시 그리면 한글 조합(IME)이 깨지고 입력값이 날아갑니다. */
function searchResultsHTML() {
  var q = search.trim();
  if (!q) return "";
  var already = {};
  S.places.forEach(function (p) { already[p.name] = 1; });
  var hits = DEST.filter(function (d) {
    return d.ko.indexOf(q) >= 0 || d.city.indexOf(q) >= 0 || d.r.indexOf(q) >= 0;
  }).slice(0, 8);

  return '<div class="results">' +
    hits.map(function (d) {
      return '<button class="res" data-act="adddest" data-c="' + d.c + '"' + (already[d.ko] ? " disabled" : "") + '>' +
        '<span class="nm">' + esc(d.ko) + (already[d.ko] ? " (추가됨)" : "") + "</span>" +
        '<span class="rg">' + esc(d.r) + "</span>" +
        '<span class="hr">' + esc(window.TV.fmt.hours(d.h)) + "</span></button>";
    }).join("") +
    '<button class="res" data-act="addcustom"><span class="nm">“' + esc(q) + '” 직접 추가</span>' +
    '<span class="rg">정보 없음</span></button></div>';
}

/* 방 안에서 지운 여행지와 표를 되돌립니다. */
/* 아직 안 채운 것들. 지금 화면에서 바로 알려 줍니다. */
function todoList() {
  var out = [], v = myVoter(), m = M();
  if (v && !voterDates(v).length) out.push({ t: "가능한 날짜를 아직 안 골랐어요.", act: "editdates", b: "고르기" });
  if (v && !voterVac(v)) out.push({ t: "휴가를 며칠 쓸 수 있는지 안 적었어요.", act: "editdates", b: "적기" });
  // 태그는 그 여행지를 올린 사람에게만 알려 줍니다. 남이 올린 곳까지 채우라고 할 일은 아니니까요.
  var mine = S.places.filter(function (p) { return p.added_by && p.added_by === me.name; });
  var noTag = mine.filter(function (p) { return !placeTags(p).length; });
  if (noTag.length && m.phase === "lobby") {
    out.push({ t: "내가 올린 여행지 중 태그가 없는 곳 " + noTag.length + "곳 (" +
      noTag.slice(0, 3).map(function (p) { return p.name; }).join(", ") +
      (noTag.length > 3 ? " 외" : "") + ")", act: null });
  }
  if ((m.phase === "vote" || canStillVote()) && draft && draft.picks.length) {
    var miss = draftBlocked().length;
    if (miss) out.push({ t: "고른 곳 중 " + miss + "곳에 이유를 아직 안 적었어요.", act: null });
  }
  return out;
}

function todoHTML() {
  var list = todoList();
  if (!list.length) return "";
  return '<div class="todo"><div class="eyebrow">아직 안 한 것</div>' +
    list.map(function (x) {
      return '<div class="todo-row"><span>' + esc(x.t) + "</span>" +
        (x.act ? '<button class="btn sm" data-act="' + x.act + '">' + esc(x.b) + "</button>" : "") + "</div>";
    }).join("") + "</div>";
}

function trashPanel() {
  if (!trashPlaces.length && !trashBallots) return "";
  var body = "";
  if (trashBallots) {
    body += '<div class="banner"><span class="mk">표</span>' +
      '<span style="flex:1">초기화한 표 <b>' + trashBallots + "장</b>이 휴지통에 있어요.</span>" +
      '<button class="btn sm" data-act="restoreballots">되돌리기</button></div>';
  }
  if (trashPlaces.length) {
    body += '<div class="results" style="border-radius:6px;border-top:1.5px solid var(--line)">' +
      trashPlaces.map(function (p) {
        return '<div class="res" style="padding:0">' +
          '<span class="nm" style="padding:11px 13px;flex:1">' + esc(p.name) + "</span>" +
          '<button class="btn sm" style="margin-right:6px" data-act="restoreplace" data-id="' + p.id + '">되돌리기</button>' +
          '<button class="btn sm ghost" style="margin-right:10px" data-act="purgeplace" data-id="' + p.id + '">삭제</button></div>';
      }).join("") + "</div>";
  }
  body += '<button class="btn ghost block" data-act="askempty">휴지통 비우기</button>' +
    '<p class="muted">비우면 되돌릴 수 없습니다.</p>';
  return '<div class="stack-sm"><button class="btn ghost block" data-act="toggletrash">' +
    (showTrash ? "휴지통 접기 ▲" : "휴지통 " + (trashPlaces.length + (trashBallots ? 1 : 0)) + "개 ▼") + "</button>" +
    (showTrash ? body : "") + "</div>";
}

function viewLobby() {
  var withGeo = S.places.filter(function (p) { return p.lat != null; });
  var list = S.places.map(function (p) {
    var editing = tagEditId === p.id;
    return '<div class="stack-sm">' + passHTML(p) +
      (editing ? tagEditorHTML(p.id) : tagsLine(p)) +
      '<div class="btn-row">' +
      (editing ? "" : '<button class="btn sm" data-act="opentags" data-id="' + p.id + '">' +
        (placeTags(p).length ? "태그 고치기" : "+ 태그 달기") + "</button>") +
      '<button class="btn sm ghost" data-act="delplace" data-id="' + p.id + '">삭제</button>' +
      (p.added_by ? '<span class="muted" style="align-self:center">' + esc(p.added_by) + " 추가</span>" : "") +
      "</div></div>";
  }).join("");

  return toastHTML() + todoHTML() +
    '<div class="stack"><div><div class="eyebrow">Step 02 · Destinations</div><h1 class="title">어디로 갈까</h1></div>' +
    '<p class="lede">나라나 도시를 검색해 추가하세요. 비행시간·항공권은 <b>인천 출발 기준 대략치</b>입니다.</p></div>' +
    shareCard() +
    '<div><input class="field" data-keep="destsearch" data-search="1" maxlength="40" ' +
    'placeholder="나라·도시 검색 (예: 베트남, 다낭, 유럽)" autocomplete="off" value="' + esc(search) + '">' +
    '<div id="destresults">' + searchResultsHTML() + "</div></div>" +
    (withGeo.length ? mapHTML(withGeo) : "") +
    (S.places.length ? '<div class="stack">' + list + "</div>"
      : '<p class="muted" style="text-align:center;padding:14px 0">아직 올라온 곳이 없어요.</p>') +
    trashPanel() +
    '<div class="stack-sm"><div class="eyebrow">참가자 ' + S.voters.length + "명</div>" +
    '<div class="chips">' + S.voters.map(function (v) {
      return '<span class="chip">' + esc(v.name) + '<span class="mk">' + voterDates(v).length + "일</span></span>";
    }).join("") + "</div></div>" + modeBanner();
}

function viewVote() {
  var m = M(), d = ensureDraft(), mine = myVoter();
  var cands = candidateIds(), max = votesFor(m.round);

  var progress = '<div class="stack-sm"><div class="eyebrow">' + votedCount(m.round) + " / " + S.voters.length + "명 완료</div>" +
    '<div class="chips">' + S.voters.map(function (v) {
      return '<span class="chip' + (hasVoted(v, m.round) ? " done" : "") + '"><span class="mk">' +
        (hasVoted(v, m.round) ? "✓" : "·") + "</span>" + esc(v.name) + "</span>";
    }).join("") + "</div></div>";

  if (hasVoted(mine, m.round)) {
    var canEdit = !!myBallot(m.round);
    return toastHTML() +
      '<div class="panel stack"><div class="eyebrow">' + (m.round === 1 ? "1차 투표" : "결선 " + (m.round - 1) + "차") + "</div>" +
      '<h1 class="title">투표 완료</h1>' +
      '<p class="lede">나머지 사람들을 기다리는 중이에요. 다 끝나면 아래 버튼으로 결과를 열 수 있어요.</p>' +
      (canEdit
        ? '<button class="btn block" data-act="askedit">내 표 고치기</button>' +
          '<p class="muted">고른 곳과 코멘트를 바꿀 수 있어요. 다른 사람 표는 그대로예요.</p>'
        : '<p class="muted">이 라운드에 낸 표를 찾지 못했어요.</p>') +
      "</div>" + progress;
  }

  if (!cands.length) {
    return toastHTML() +
      '<div class="panel stack"><div class="eyebrow">' + (m.round === 1 ? "1차 투표" : "결선") + "</div>" +
      '<h1 class="title">고를 여행지가 없어요</h1>' +
      '<p class="lede">후보가 모두 지워졌습니다. 헤더의 <b>02 여행지</b> 에서 여행지를 추가한 뒤 다시 시작해 주세요.</p></div>';
  }

  var cards = cands.map(function (id) {
    var p = placeById(id); if (!p) return "";
    var picked = d.picks.indexOf(id) >= 0;
    return '<div class="pick-wrap"><button class="tapcard" data-act="pick" data-id="' + id + '">' +
      passHTML(p, { selected: picked, tick: true }) + "</button>" +
      tagsLine(p) + (picked ? composer(id) : "") + "</div>";
  }).join("");

  return toastHTML() + todoHTML() +
    (m.phase === "result"
      ? '<div class="banner"><span class="mk">늦참 환영</span><span>결과가 이미 열렸지만 <b>아직 투표할 수 있어요.</b> 내 표가 들어가면 결과도 같이 바뀝니다.</span></div>'
      : "") +
    '<div class="stack"><div><div class="eyebrow">' +
    (m.round === 1 ? "Step 03 · 1차 투표" : "Step 04 · 결선 " + (m.round - 1) + "차") + "</div>" +
    '<h1 class="title">' + (m.round === 1 ? (NUM_KO[VOTES_R1] || VOTES_R1) + " 곳을 고르세요" : "한 곳만 고르세요") + "</h1></div>" +
    '<p class="lede">지금 <b>' + d.picks.length + " / " + max + "표</b> 썼어요. 고른 곳마다 이유를 적고 <b>번역기 말투로 바꿔야</b> 제출됩니다.</p></div>" +
    '<div class="stack" style="gap:16px">' + cards + "</div>" + progress;
}

function composer(id) {
  var st = draft.status[id] || "idle";
  var raw = draft.raw[id] || "", ai = draft.ai[id] || "", err = draft.err[id] || "";
  var len = chars(raw), over = len > COMMENT_MAX;

  var tag = st === "ready" ? '<span class="tag ok" id="tag-' + id + '">변환 완료</span>'
    : st === "raw" ? '<span class="tag warn" id="tag-' + id + '">원문 그대로</span>'
    : raw.trim() ? '<span class="tag warn" id="tag-' + id + '">변환 필요</span>'
    : '<span class="tag warn" id="tag-' + id + '">필수</span>';

  var body, editor;
  if (st === "ready" || st === "raw") {
    editor = "";
    body = '<div class="aibox" id="ai-' + id + '">' + esc(st === "ready" ? ai : raw) + "</div>" +
      '<p class="muted">' + (st === "ready" ? "이 문장이 그대로 제출돼요. 원문은 저장되지 않습니다."
        : "변환 없이 이대로 제출돼요. 말투로 누군지 드러날 수 있어요.") + "</p>" +
      '<div class="btn-row"><button class="btn sm" data-act="convert" data-id="' + id + '">' +
      (st === "ready" ? "다시 바꾸기" : "번역기 말투로 바꾸기") + "</button>" +
      '<button class="btn sm ghost" data-act="unlock" data-id="' + id + '">원문 고치기</button></div>';
  } else {
    editor = '<textarea class="field" data-keep="raw-' + id + '" data-raw="' + id + '" maxlength="' + COMMENT_MAX +
      '" placeholder="평소 말투 그대로 편하게 쓰세요. 제출 전에 번역기 말투로 바꿔 줄게요.">' + esc(raw) + "</textarea>" +
      '<div class="counter' + (over ? " over" : "") + '" id="cnt-' + id + '">' + len + " / " + COMMENT_MAX + "</div>";
    body = (err ? '<div class="aibox err">' + esc(err) + "</div>" : "") +
      '<div class="btn-row"><button class="btn sm primary" data-act="convert" data-id="' + id + '"' +
      (raw.trim() && !over ? "" : " disabled") + ">번역기 말투로 바꾸기</button>" +
      '<button class="btn sm ghost" data-act="useraw" data-id="' + id + '"' +
      (raw.trim() && !over ? "" : " disabled") + ">원문 그대로 쓰기</button></div>";
  }
  return '<div class="compose"><div class="compose-head"><span class="eyebrow">고른 이유</span>' + tag + "</div>" +
    editor + body + "</div>";
}

function heatHTML() {
  var counts = dateCounts(), keys = Object.keys(counts);
  if (!keys.length) return "";
  var total = S.voters.length || 1;
  var byMonth = {};
  keys.forEach(function (d) { (byMonth[d.slice(0, 7)] = byMonth[d.slice(0, 7)] || []).push(d); });
  var C = window.TV.cal;

  var names = dateNames();
  var head = C.WEEKDAYS.map(function (w, i) {
    return '<div class="heat-wd' + (i === 0 || i === 6 ? " we" : "") + '">' + w + "</div>";
  }).join("");

  var grids = Object.keys(byMonth).sort().map(function (ym) {
    var y = Number(ym.slice(0, 4)), mm = Number(ym.slice(5));
    var lead = new Date(y, mm - 1, 1).getDay(), n = new Date(y, mm, 0).getDate();
    var cells = "", i, d;
    for (i = 0; i < lead; i++) cells += '<div class="heat-cell pad"></div>';
    for (d = 1; d <= n; d++) {
      var key = C.iso(y, mm, d);
      var who = names[key] || [];
      var c = who.length, ratio = c / total;
      var lvl = c === 0 ? "" : ratio >= 1 ? " h4" : ratio >= .66 ? " h3" : ratio >= .34 ? " h2" : " h1";
      // 전원 가능한 날은 이름을 늘어놓는 대신 ALL 한 글자로
      var body = c === 0 ? ""
        : (c === S.voters.length && S.voters.length > 1)
          ? '<span class="hnames all">ALL</span>'
          : '<span class="hnames">' + who.map(esc).join("<br>") + "</span>";
      cells += '<div class="heat-cell' + lvl + '"><span class="dd">' + d + "</span>" + body + "</div>";
    }
    var rest = (lead + n) % 7;
    if (rest) for (i = rest; i < 7; i++) cells += '<div class="heat-cell pad"></div>';
    return '<div class="stack-sm"><div class="eyebrow">' + y + "." + pad2(mm) + "</div>" +
      '<div class="heat-grid wd">' + head + "</div>" +
      '<div class="heat-grid">' + cells + "</div></div>";
  }).join("");

  var best = bestDates(), rec = recommendation(), limit = vacationLimit();
  var vacLine = limit == null
    ? '<p class="muted">휴가 일수를 적은 사람이 없어서 기간은 안 맞춰 봤어요.</p>'
    : '<p class="muted">휴가는 <b>평일 ' + limit + "일</b>까지 (가장 빠듯한 사람 기준)</p>";

  var recBlock = rec
    ? '<div class="panel stack-sm"><div class="eyebrow">추천 일정</div>' +
      '<h2 class="sub">' + esc(C.summarize(rec.dates)) + "</h2>" +
      '<p class="lede">' + rec.dates.length + "일 (평일 " + rec.weekdays + "일) · " +
      rec.people + " / " + S.voters.length + "명 가능</p>" + vacLine + "</div>"
    : "";

  return '<div class="stack"><div class="eyebrow">언제 갈까</div>' +
    (best.max ? '<div class="stack-sm"><p class="lede"><b>' + best.max + "명</b>이 모두 가능한 날이 <b>" +
      best.dates.length + '일</b> 있어요.</p><div class="best"><b>' + esc(C.summarize(best.dates)) + "</b></div></div>" : "") +
    recBlock +
    '<button class="btn block" data-act="toggleheat">' +
      (showHeat ? "달력 접기 ▲" : "달력으로 보기 ▼") + "</button>" +
    (showHeat ? '<p class="muted">각 날짜에 <b>그날 가능한 사람</b>이 적혀 있어요. 전원 가능한 날은 ALL 로 표시됩니다.</p>' + grids : "") +
    '<div class="stack-sm"><div class="eyebrow">참가자별 휴가</div><div class="chips">' +
    S.voters.map(function (v) {
      return '<span class="chip">' + esc(v.name) + '<span class="mk">' +
        (voterVac(v) ? "평일 " + voterVac(v) + "일" : "미입력") + "</span></span>";
    }).join("") + "</div></div></div>";
}

function viewResult() {
  var m = M(), o = outcome(m.round);
  var maxN = Math.max.apply(null, o.rows.map(function (r) { return r.n; }).concat([1]));

  var rank = o.rows.map(function (r, i) {
    var lead = r.n === o.rows[0].n && r.n > 0;
    return '<div class="rrow' + (lead ? " lead" : "") + '"><div class="rpos">' + pad2(i + 1) + "</div>" +
      '<div class="rname">' + esc(r.name) + '</div><div class="rnum">' + r.n + "표</div></div>" +
      '<div class="bar"><span style="width:' + Math.round(r.n / maxN * 100) + "%;background:" +
      (lead ? "var(--accent)" : "var(--ink-2)") + '"></span></div>';
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
    note = '<p class="lede">' + (m.round === 1
      ? "상위 <b>" + o.finalists.length + "곳</b>만 남기고 결선으로 갑니다."
      : "<b>" + o.finalists.length + "곳</b>이 같은 표를 받았어요.") +
      " 재투표할지 돌림판을 돌릴지 다음 화면에서 고르세요.</p>";
  }

  var finalChips = (o.kind === "tie" && o.finalists.length)
    ? '<div class="stack-sm"><div class="eyebrow">결선 진출</div><div class="chips">' +
      o.finalists.map(function (id) { return '<span class="chip done">' + esc(placeName(id)) + "</span>"; }).join("") + "</div></div>"
    : "";

  return toastHTML() +
    '<div class="stack"><div><div class="eyebrow">' +
    (m.round === 1 ? "1차 투표 결과" : "결선 " + (m.round - 1) + "차 결과") + " · " + o.ballots + "명 참여</div>" +
    head + "</div>" + note + "</div>" +
    '<div class="panel"><div class="stack-sm">' + rank + "</div></div>" +
    (myBallot(m.round)
      ? '<div class="stack-sm"><button class="btn block" data-act="askedit">내 표 고치기</button>' +
        '<p class="muted">고른 곳과 코멘트를 바꿀 수 있어요. 바꾸면 순위도 다시 계산됩니다.</p></div>'
      : "") +
    finalChips + commentsPanel(m.round) + heatHTML() +
    placesPanel(candidateIds()) + shareCard();
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

function viewChoose() {
  var m = M();
  return toastHTML() +
    '<div class="stack"><div><div class="eyebrow">결선 방식</div><h1 class="title">어떻게 끝낼까요?</h1></div>' +
    '<p class="lede"><b>' + (m.finalists || []).length + "곳</b>이 남았어요. 한 번 더 투표하거나, 그냥 운에 맡기거나.</p>" +
    '<div class="chips">' + (m.finalists || []).map(function (id) {
      return '<span class="chip done">' + esc(placeName(id)) + "</span>";
    }).join("") + "</div></div>" +
    '<div class="pill-toggle">' +
    '<button class="btn" data-act="revote"><span class="k">재투표</span><span class="d">한 명당 1표<br>코멘트도 다시</span></button>' +
    '<button class="btn" data-act="wheel"><span class="k">돌림판</span><span class="d">운에 맡기기<br>한 방에 결정</span></button></div>' +
    '<p class="muted" style="text-align:center">아무나 눌러도 돼요. 모두의 화면이 같이 넘어갑니다.</p>';
}

/* 모노톤 — 라벨이 전부 흰색이라 어두운 회색 계열만 씁니다 */
var SEG_FILL = ["#141414", "#3A3A3A", "#242424", "#525252", "#1C1C1C", "#454545", "#2E2E2E", "#5C5C5C"];

function viewWheel() {
  var m = M();
  var cands = (m.spin && m.spin.order && m.spin.order.length)
    ? m.spin.order.filter(function (id) { return !!placeById(id); }) : candidateIds();
  var n = cands.length, seg = 360 / n, R = 92, C = 100;
  var paths = "", labels = "", i;
  for (i = 0; i < n; i++) {
    var a0 = (i * seg - 90) * Math.PI / 180, a1 = ((i + 1) * seg - 90) * Math.PI / 180;
    var x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0);
    var x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
    paths += '<path d="M' + C + "," + C + " L" + x0.toFixed(2) + "," + y0.toFixed(2) +
      " A" + R + "," + R + " 0 " + (seg > 180 ? 1 : 0) + " 1 " + x1.toFixed(2) + "," + y1.toFixed(2) +
      ' Z" fill="' + SEG_FILL[i % SEG_FILL.length] + '" stroke="rgba(255,255,255,.5)" stroke-width="1.2"/>';
    var am = ((i + 0.5) * seg - 90) * Math.PI / 180;
    var lr = n <= 4 ? 50 : 58;
    var lx = C + lr * Math.cos(am), ly = C + lr * Math.sin(am);
    var fs = n <= 4 ? 12 : n <= 6 ? 10 : 8.5;
    var cap = n <= 4 ? 8 : n <= 6 ? 6 : 5;
    var nm = placeName(cands[i]);
    if (nm.length > cap) nm = nm.slice(0, cap - 1) + "…";
    labels += '<text x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" fill="#fff" font-size="' + fs +
      '" font-family="Noto Sans KR, sans-serif" font-weight="700" text-anchor="middle" dominant-baseline="middle"' +
      ' paint-order="stroke" stroke="rgba(0,0,0,.3)" stroke-width="2">' + esc(nm) + "</text>";
  }
  var revealed = !!(m.spin && spinSeen[m.spin.id] === "done");
  return toastHTML() +
    '<div class="stack"><div><div class="eyebrow">돌려돌려 돌림판</div>' +
    '<h1 class="title">' + (revealed ? "결과 나왔습니다" : "한 방에 정합니다") + "</h1></div>" +
    '<p class="lede">' + (revealed ? "바늘이 가리킨 곳은 <b>" + esc(placeName(m.winner)) + "</b>."
      : "아무나 한 번만 돌리면 돼요. 모두의 화면에서 같이 돌아갑니다.") + "</p></div>" +
    '<div class="wheelwrap"><div class="needle"></div>' +
    '<svg viewBox="0 0 200 200" aria-hidden="true"><g id="wheelspin">' + paths + labels + "</g>" +
    '<circle cx="100" cy="100" r="92" fill="none" stroke="var(--ink)" stroke-width="2.5"/></svg>' +
    '<div class="hub">SPIN</div></div>' +
    (revealed ? '<div class="big-result"><div class="kicker">Winner</div><div class="name">' +
      esc(placeName(m.winner)) + "</div></div>" : "");
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

function viewDone() {
  var m = M(), p = placeById(m.winner);
  var how = m.tiebreak === "wheel" ? "돌림판으로 결정" : m.round > 1 ? "결선 투표로 결정" : "1차 투표 과반으로 결정";
  var rec = recommendation();
  var allComments = "", r;
  for (r = 1; r <= m.round; r++) {
    var block = commentsPanel(r);
    if (block.indexOf("코멘트가 없었어요") >= 0) continue;
    allComments += (m.round > 1
      ? '<div class="stack-sm"><div class="eyebrow">' + (r === 1 ? "1차 투표" : "결선 " + (r - 1) + "차") + " 코멘트</div>" + block + "</div>"
      : block);
  }
  return toastHTML() +
    '<div class="big-result"><div class="kicker">Destination</div>' +
    '<div class="name">' + esc(p ? p.name : "?") + "</div>" +
    '<p class="muted">' + how + " · " + S.voters.length + "명 · " + m.round + "라운드</p></div>" +
    (p ? passHTML(p, { cls: " k" }) : "") +
    (p && p.lat != null ? mapHTML([p]) : "") +
    (rec ? '<div class="panel stack-sm"><div class="eyebrow">추천 일정</div>' +
      '<h2 class="sub">' + esc(window.TV.cal.summarize(rec.dates)) + "</h2>" +
      '<p class="muted">' + rec.dates.length + "일 (평일 " + rec.weekdays + "일) · " +
      rec.people + " / " + S.voters.length + "명 가능" +
      (rec.limit == null ? "" : " · 휴가 평일 " + rec.limit + "일 한도") + "</p></div>" : "") +
    allComments + heatHTML() +
    '<button class="btn block" data-act="toggleplaces">' +
      (showPlaces ? "여행지 정보 접기 ▲" : "여행지 정보 보기 ▼") + "</button>" +
    (showPlaces ? placesPanel(S.places.map(function (p) { return p.id; })) : "") +
    shareCard();
}

/* ============================================================
   13. dock / foot / modal
   ============================================================ */
function renderDock() {
  var m = M(), inner = "", hint = "";
  if (mode === "connecting" || needsRoom()) return "";

  if (editingDates) {
    inner = '<button class="btn red block" data-act="savedates"' + (dateSel && dateSel.size ? "" : " disabled") + ">날짜 저장</button>";
    hint = dateSel && dateSel.size ? dateSel.size + "일 선택함" : "최소 하루는 골라 주세요.";
  } else if (needsDates()) {
    inner = '<button class="btn red block" data-act="join"' + (dateSel && dateSel.size ? "" : " disabled") + ">참가하기</button>";
    hint = dateSel && dateSel.size ? dateSel.size + "일 선택함" : "이름을 적고 가능한 날짜를 고르세요.";
  } else if (viewStep && viewStep !== liveStep()) {
    // 지난 단계를 보는 중에는 현재 단계 버튼을 노출하지 않습니다. 실수로 눌리면 안 되니까요.
    inner = '<button class="btn block" data-act="golive">현재 단계로 돌아가기</button>';
    hint = STEPS[viewStep - 1].label + ' 기록을 보는 중이에요.';
  } else if (m.phase === "lobby") {
    inner = '<button class="btn red block" data-act="startvote"' + (S.places.length < 2 ? " disabled" : "") + ">1차 투표 시작 · 한 명당 " + VOTES_R1 + "표</button>";
    hint = S.places.length < 2 ? "여행지를 2곳 이상 올리면 시작할 수 있어요." : S.places.length + "곳 · 참가자 " + S.voters.length + "명";
  } else if (m.phase === "vote") {
    if (hasVoted(myVoter(), m.round)) {
      var all = S.voters.length > 0 && votedCount(m.round) === S.voters.length;
      inner = '<button class="btn ' + (all ? "red " : "") + 'block" data-act="openresult">결과 열기</button>';
      hint = all ? "모두 투표를 마쳤어요." : (S.voters.length - votedCount(m.round)) + "명이 아직이에요. 지금 열면 그대로 집계됩니다.";
    } else {
      var blocked = draft ? draftBlocked() : [];
      inner = '<button class="btn red block" data-act="review"' + (canSubmit() ? "" : " disabled") + ">확인하고 투표하기</button>";
      hint = !draft || draft.picks.length === 0 ? "최소 한 곳은 골라 주세요."
        : blocked.length ? "고른 곳마다 이유를 " + COMMENT_MAX + "자 이내로 적고 말투 변환까지 마쳐 주세요."
        : draft.picks.length + "곳 선택함";
    }
  } else if (canStillVote()) {
    var blocked2 = draft ? draftBlocked() : [];
    inner = '<button class="btn red block" data-act="review"' + (canSubmit() ? "" : " disabled") + ">확인하고 투표하기</button>";
    hint = !draft || draft.picks.length === 0 ? "최소 한 곳은 골라 주세요."
      : blocked2.length ? "고른 곳마다 이유를 " + COMMENT_MAX + "자 이내로 적고 말투 변환까지 마쳐 주세요."
      : draft.picks.length + "곳 선택함";
  } else if (m.phase === "result") {
    var o = outcome(m.round);
    var left = S.voters.length - votedCount(m.round);
    var waiting = S.voters.length === 0 || left > 0;
    var pend = S.voters.filter(function (v) { return !hasVoted(v, m.round); }).map(function (v) { return v.name; });
    if (o.kind === "empty") inner = '<button class="btn block" data-act="backvote">투표로 돌아가기</button>';
    else if (o.kind === "win") {
      inner = '<button class="btn red block" data-act="confirmwin" data-id="' + o.winner + '"' + (waiting ? " disabled" : "") + ">여기로 확정하기</button>";
      hint = waiting ? pend.join(", ") + " 님이 아직 투표 전이에요." : "";
    } else {
      inner = '<button class="btn primary block" data-act="gochoose" data-ids="' + o.finalists.join(",") + '"' + (waiting ? " disabled" : "") + ">결선 방식 고르기</button>";
      hint = waiting ? pend.join(", ") + " 님이 아직 투표 전이에요. 다 하면 열립니다." : "";
    }
  } else if (m.phase === "wheel") {
    var revealed = !!(m.spin && spinSeen[m.spin.id] === "done");
    if (revealed) inner = '<button class="btn red block" data-act="confirmwin" data-id="' + m.winner + '">여기로 확정하기</button>';
    else if (m.spin) inner = '<button class="btn block" disabled>돌아가는 중…</button>';
    else inner = '<button class="btn red block" data-act="spin">돌리기</button>';
  } else if (m.phase === "done") {
    inner = '<button class="btn block" data-act="home">여행 목록으로</button>';
    hint = "새로 정하려면 여행을 새로 만드세요. 이 기록은 그대로 남습니다.";
  }
  if (!inner) return "";
  return '<div class="dock"><div class="dock-in">' + inner + (hint ? '<div class="hint">' + esc(hint) + "</div>" : "") + "</div></div>";
}

/* 예전에는 작은 밑줄 링크 네 개가 나란히 있어서 오탭하기 쉬웠습니다.
   이제 하나의 메뉴 버튼으로 모으고, 위험한 항목은 시트 맨 아래에 따로 둡니다. */
function renderFoot() {
  if (mode === "connecting" || needsRoom() || needsJoin() || editingDates) return "";
  return '<button class="menubtn" data-act="openmenu">⋯ 메뉴</button>';
}

function menuSheet() {
  var m = M(), rows = "";
  function row(act, label, sub) {
    return '<button class="menu-row" data-act="' + act + '"><span class="l">' + label + "</span>" +
      (sub ? '<span class="s">' + sub + "</span>" : "") + "</button>";
  }
  if (myVoter()) rows += row("editdates", "내 날짜·휴가 수정", "가능한 날짜와 휴가 일수");
  rows += row("switchperson", "다른 사람으로", "이름을 다시 고릅니다");
  if (mode === "shared") rows += row("copylink", "링크 복사", "단톡방에 뿌리기");
  if (mode === "local" && m.phase === "vote") rows += row("next", "다음 사람에게 넘기기", "");

  return '<div class="scrim" data-act="closemodal"><div class="sheet"><div class="grab"></div>' +
    '<div class="stack-sm"><div class="eyebrow">메뉴</div>' + rows +
    '<div class="menu-danger"><div class="eyebrow">되돌리기 어려운 작업</div>' +
    row("askclear", "모든 참가자 표 초기화", "삭제 코드가 필요합니다") + "</div>" +
    '<button class="btn ghost block" data-act="closemodal">닫기</button></div></div></div>';
}

function renderModal() {
  if (!modalView) return "";
  if (modalView === "confirm") {
    var rows = draft.picks.map(function (id) {
      var c = commentFor(id);
      return '<div class="stack-sm"><h2 class="sub">' + esc(placeName(id)) + "</h2>" +
        '<div class="cmt"><span class="anon">제출될 코멘트</span>' + esc(c) + "</div></div>";
    }).join("");
    return '<div class="scrim" data-act="closemodal"><div class="sheet"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">마지막 확인</div>' +
      '<h1 class="title" style="font-size:24px">이대로 제출할까요?</h1></div>' +
      '<p class="lede">제출 뒤에는 고칠 수 없어요. 이름은 함께 저장되지 않습니다.</p>' + rows +
      '<div class="btn-row" style="margin-top:4px">' +
      '<button class="btn red" style="flex:1" data-act="submit">제출하기</button>' +
      '<button class="btn ghost" data-act="closemodal">더 고칠래요</button></div></div></div></div>';
  }
  if (modalView === "editballot") {
    return '<div class="scrim" data-act="closemodal"><div class="sheet"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">내 표 고치기</div>' +
      '<h1 class="title" style="font-size:24px">본인 이름을 적어 주세요</h1></div>' +
      '<p class="lede">고른 곳과 코멘트가 그대로 불러와집니다. 고친 뒤 다시 제출해야 반영돼요. ' +
      '<b>다른 사람 표는 건드리지 않습니다.</b></p>' +
      '<input class="field" data-keep="editname" data-editname="1" maxlength="12" ' +
        'placeholder="' + esc(me.name) + '" autocomplete="off" value="' + esc(editName) + '">' +
      '<div class="btn-row"><button class="btn red" style="flex:1" data-act="doedit">확인하고 고치기</button>' +
      '<button class="btn ghost" data-act="closemodal">그만두기</button></div></div></div></div>';
  }
  if (modalView === "menu") return menuSheet();
  if (modalView === "emptytrash") {
    return '<div class="scrim" data-act="closemodal"><div class="sheet"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">휴지통 비우기</div>' +
      '<h1 class="title" style="font-size:24px">완전히 지울까요?</h1></div>' +
      '<p class="lede">휴지통의 여행지 <b>' + trashPlaces.length + "곳</b>과 지운 표 <b>" + trashBallots +
      "장</b>이 사라집니다. 되돌릴 수 없습니다.</p>" +
      '<div class="btn-row"><button class="btn" style="flex:1;border-color:var(--accent)" data-act="doempty">비우기</button>' +
      '<button class="btn ghost" data-act="closemodal">그만두기</button></div></div></div></div>';
  }
  if (modalView === "guard") {
    var g = guardAction || {};
    return '<div class="scrim" data-act="closemodal"><div class="sheet"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">삭제 코드</div>' +
      '<h1 class="title" style="font-size:24px">' + esc(g.title || "") + "</h1></div>" +
      '<p class="lede">' + esc(g.desc || "") + " 되돌릴 수 없습니다.</p>" +
      '<input class="field" data-keep="guardcode" data-guardcode="1" inputmode="numeric" maxlength="4" ' +
        'placeholder="숫자 4자리" autocomplete="off" value="' + esc(codeDraft) + '">' +
      '<div class="btn-row"><button class="btn" style="flex:1;border-color:var(--accent)" data-act="doguard">확인</button>' +
      '<button class="btn ghost" data-act="closemodal">그만두기</button></div></div></div></div>';
  }
  if (modalView === "openresult") {
    var leftN = S.voters.length - votedCount(M().round);
    return '<div class="scrim" data-act="closemodal"><div class="sheet"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">결과 열기</div>' +
      '<h1 class="title" style="font-size:24px">아직 ' + leftN + '명이 투표 전이에요</h1></div>' +
      '<p class="lede">열어도 <b>그 사람들과 새로 들어오는 사람은 계속 투표할 수 있어요.</b> ' +
      '표가 들어오면 결과도 같이 바뀝니다. 지금 나온 순위만 미리 보는 셈이에요.</p>' +
      '<div class="btn-row"><button class="btn red" style="flex:1" data-act="doopenresult">그래도 열기</button>' +
      '<button class="btn ghost" data-act="closemodal">기다리기</button></div></div></div></div>';
  }
  if (modalView === "home") {
    return '<div class="scrim" data-act="closemodal"><div class="sheet"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">나가기</div>' +
      '<h1 class="title" style="font-size:24px">쓰던 투표를 버리고 나갈까요?</h1></div>' +
      '<p class="lede">고른 곳과 쓰던 코멘트가 사라집니다. 이미 제출한 표는 그대로예요.</p>' +
      '<div class="btn-row"><button class="btn" style="flex:1" data-act="leavehome">나가기</button>' +
      '<button class="btn ghost" data-act="closemodal">계속 쓰기</button></div></div></div></div>';
  }
  if (modalView === "delroom") {
    return '<div class="scrim" data-act="closemodal"><div class="sheet"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">여행 삭제</div>' +
      '<h1 class="title" style="font-size:24px">“' + esc(delTarget.title || "이 여행") + '” 을 지울까요?</h1></div>' +
      '<p class="lede">여행지, 표, 코멘트, 참가자 날짜가 전부 사라집니다. 되돌릴 수 없어요.</p>' +
      '<div class="btn-row"><button class="btn" style="flex:1;border-color:var(--ink)" data-act="dodelroom">지우기</button>' +
      '<button class="btn ghost" data-act="closemodal">그만두기</button></div></div></div></div>';
  }
  if (modalView === "handoff") {
    return '<div class="scrim"><div class="sheet"><div class="grab"></div>' +
      '<div class="stack"><div><div class="eyebrow">투표 완료</div>' +
      '<h1 class="title" style="font-size:24px">다음 사람에게 폰을 넘겨 주세요</h1></div>' +
      '<p class="lede">넘기기를 누르면 화면이 비워지고, 다음 사람이 이름과 날짜부터 입력합니다. 방금 낸 표는 이미 익명으로 저장됐어요.</p>' +
      '<div class="btn-row"><button class="btn red" style="flex:1" data-act="next">넘기기</button>' +
      '<button class="btn ghost" data-act="closemodal">잠깐 볼게요</button></div></div></div></div>';
  }
  return "";
}

/* ============================================================
   14. events
   ============================================================ */
document.addEventListener("input", function (e) {
  var t = e.target;
  if (!t || !t.dataset) return;
  if (t.dataset.keep === "vacdays") { vacDays = t.value; return; }
  if (t.dataset.titleinput) { titleDraft = t.value; return; }
  if (t.dataset.guardcode) { codeDraft = t.value.replace(/[^0-9]/g, "").slice(0, 4); if (t.value !== codeDraft) t.value = codeDraft; return; }
  if (t.dataset.editname) { editName = t.value; return; }
  if (t.dataset.newtitle) { newRoomTitle = t.value; return; }
  if (t.dataset.newcode) { newRoomCode4 = t.value.replace(/[^0-9]/g, "").slice(0, 4); if (t.value !== newRoomCode4) t.value = newRoomCode4; return; }
  if (t.dataset.taginput) {
    // 스페이스나 쉼표로도 태그가 끊기게
    if (/[s,]/.test(t.value)) { tagText = t.value; if (addTagFromInput()) render(); return; }
    tagText = t.value;
    return;
  }
  if (t.dataset.search) {
    // 결과 목록만 바꿉니다. 전체 재렌더는 한글 조합을 끊고 입력값을 날립니다.
    search = t.value;
    var box = document.getElementById("destresults");
    if (box) box.innerHTML = searchResultsHTML();
    return;
  }
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
  if (tg) { tg.className = "tag warn"; tg.textContent = filled ? "변환 필요" : "필수"; }
  var cnt = document.getElementById("cnt-" + id);
  if (cnt) { cnt.className = "counter" + (over ? " over" : ""); cnt.textContent = len + " / " + COMMENT_MAX; }
  $("#dock").innerHTML = renderDock();
});

document.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  var t = e.target;
  if (!t || !t.dataset) return;
  if (t.dataset.keep === "joinname" || t.dataset.keep === "roomtitle") { e.preventDefault(); t.blur(); }
  if (t.dataset.keep === "idname") { e.preventDefault(); identifyAs(t.value); }
  if (t.dataset.titleinput) { titleDraft = t.value; return; }
  if (t.dataset.guardcode) { codeDraft = t.value.replace(/[^0-9]/g, "").slice(0, 4); if (t.value !== codeDraft) t.value = codeDraft; return; }
  if (t.dataset.editname) { editName = t.value; return; }
  if (t.dataset.newtitle) { newRoomTitle = t.value; return; }
  if (t.dataset.newcode) { newRoomCode4 = t.value.replace(/[^0-9]/g, "").slice(0, 4); if (t.value !== newRoomCode4) t.value = newRoomCode4; return; }
  if (t.dataset.taginput) { e.preventDefault(); if (addTagFromInput()) render(); }
  if (t.dataset.titleinput) { e.preventDefault(); saveTitle(); }
});

/* 클릭 한 번에 한 동작만. 네트워크를 기다리는 동안 다시 눌러도 무시하고,
   누른 버튼은 눌린 티가 나게 잠급니다. */
var busy = false;

function dispatch(act, el, id) {
  if (act === "home") return goHome();
  if (act === "back") return goBack();
  if (act === "doopenresult") return openResult();
  if (act === "askedit") { modalView = "editballot"; render(); return; }
  if (act === "doedit") return editMyBallot();
  if (act === "leavehome") { draft = null; modalView = null; return goHome(); }
  if (act === "createroom") return createRoom(newRoomTitle, newRoomYear);
  if (act === "setyear") { newRoomYear = Number(el.dataset.y); render(); return; }
  if (act === "enterroom") return joinRoomByCode(el.dataset.code);
  if (act === "askdelroom") {
    guardAction = { kind: "delroom", code: el.dataset.code,
      title: "“" + (el.dataset.t || "이 여행") + "” 을 지울까요?",
      desc: "여행지, 표, 코멘트, 참가자 날짜가 전부 사라집니다." };
    codeDraft = ""; modalView = "guard"; render(); return;
  }
  if (act === "copylink") return copyLink();
  if (act === "join") { var j = document.querySelector('[data-keep="joinname"]'); return joinAsName(j ? j.value : ""); }
  if (act === "editdates") { editingDates = true; startDatePick(); render(); return; }
  if (act === "savedates") return saveDatesOnly();
  if (act === "adddest") {
    var d = DEST.filter(function (x) { return x.c === el.dataset.c; })[0];
    return d ? addDestination(d) : undefined;
  }
  if (act === "addcustom") return addCustomPlace();
  if (act === "identify") { var nf = document.querySelector('[data-keep="idname"]'); identifyAs(nf ? nf.value : ""); return; }
  if (act === "iam") { identifyAs(el.dataset.n); return; }
  if (act === "switchperson") { switchPerson(); return; }
  if (act === "toggleheat") { showHeat = !showHeat; render(); return; }
  if (act === "toggleplaces") { showPlaces = !showPlaces; render(); return; }
  if (act === "gostep") { goStep(el.dataset.n); return; }
  if (act === "golive") { viewStep = null; editingDates = false; dateSel = null; render(); return; }
  if (act === "edittitle") { titleEdit = true; titleDraft = M().title || ""; newRoomCode4 = ""; render(); return; }
  if (act === "savetitle") return saveTitle();
  if (act === "canceltitle") { titleEdit = false; titleDraft = ""; newRoomCode4 = ""; render(); return; }
  if (act === "opentags") { openTags(id); return; }
  if (act === "savetags") return saveTags();
  if (act === "canceltags") { tagEditId = null; tagDraft = []; tagText = ""; render(); return; }
  if (act === "rmtag") { tagDraft.splice(Number(el.dataset.i), 1); render(); return; }
  if (act === "sugtag") { addTagFromInput(el.dataset.t); render(); return; }
  if (act === "delplace") return store.delPlace(id);
  if (act === "startvote") return startVote();
  if (act === "pick") { togglePick(id); return; }
  if (act === "convert") { convert(id); return; }
  if (act === "useraw") { ensureDraft(); draft.status[id] = "raw"; render(); return; }
  if (act === "unlock") { ensureDraft(); draft.status[id] = "idle"; draft.err[id] = ""; render(); return; }
  if (act === "review") { if (canSubmit()) { modalView = "confirm"; render(); } return; }
  if (act === "submit") return submitBallot();
  if (act === "closemodal") { modalView = null; guardAction = null; codeDraft = ""; editName = ""; render(); return; }
  if (act === "openresult") return openResult();
  if (act === "backvote") return store.setMeta({ phase: "vote" });
  if (act === "confirmwin") return confirmWin(id);
  if (act === "gochoose") return goChoose((el.dataset.ids || "").split(",").filter(Boolean));
  if (act === "revote") return pickRevote();
  if (act === "wheel") return pickWheel();
  if (act === "spin") return doSpin();
  if (act === "askclear") {
    guardAction = { kind: "clearvotes", title: "모든 참가자 표를 지울까요?",
      desc: "이번 라운드에 낸 표와 코멘트가 전부 사라지고 모두 처음부터 다시 투표합니다. 여행지·참가자·날짜는 그대로 남습니다." };
    codeDraft = ""; modalView = "guard"; render(); return;
  }
  if (act === "doguard") return runGuarded();
  if (act === "toggletrash") { showTrash = !showTrash; render(); return; }
  if (act === "restoreroom") return restoreRoom(el.dataset.code);
  if (act === "restoreplace") return store.undelPlace(id);
  if (act === "restoreballots") return restoreBallots();
  if (act === "purgeplace") return store.purgePlace(id);
  if (act === "askempty") { modalView = "emptytrash"; render(); return; }
  if (act === "doempty") return emptyTrash();
  if (act === "askpurge") {
    guardAction = { kind: "purgeroom", code: el.dataset.code,
      title: "“" + (el.dataset.t || "이 여행") + "” 을 영구히 지울까요?",
      desc: "휴지통에서도 사라져 다시는 되돌릴 수 없습니다." };
    codeDraft = ""; modalView = "guard"; render(); return;
  }
  if (act === "openmenu") { modalView = "menu"; render(); return; }
  if (act === "next") { nextPerson(); return; }
}

document.addEventListener("click", function (e) {
  var el = e.target.closest ? e.target.closest("[data-act]") : null;
  if (!el) return;
  if (el.classList.contains("scrim") && e.target !== el) return;
  if (busy) return;   // 처리 중이면 두 번째 클릭은 무시

  var p;
  try { p = dispatch(el.dataset.act, el, el.dataset.id); }
  catch (err) { busy = false; throw err; }

  if (p && typeof p.then === "function") {
    busy = true;
    el.classList.add("is-loading");
    el.setAttribute("aria-busy", "true");
    document.body.classList.add("busy");
    var done = function () {
      busy = false;
      document.body.classList.remove("busy");
      render();
    };
    p.then(done, function (err) { done(); console.error(err); });
  }
});

window.addEventListener("hashchange", function () {
  var code = (location.hash || "").replace(/^#\/?/, "").trim().toUpperCase();
  if (mode === "shared" && code && code !== roomCode) joinRoomByCode(code);
});

render();
initStore();

})();
