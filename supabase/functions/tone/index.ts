// 코멘트를 AI 말투로 바꾸는 프록시.
//
// GEMINI_API_KEY 는 오직 여기에만 존재합니다. 브라우저는 이 함수만 부르고,
// 키는 절대 클라이언트로 내려가지 않습니다.
//
// 배포:
//   npx supabase@latest secrets set GEMINI_API_KEY=...
//   npx supabase@latest functions deploy tone

import { GoogleGenAI } from "npm:@google/genai";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "gemini-3.5-flash";   // 무료 티어 사용 가능
const MAX_CHARS = 100;      // 원문 상한
const OUT_CHARS = 100;      // 변환문 상한
const HOURLY_LIMIT = 40;    // 사용자당 시간당 변환 횟수

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const ai = new GoogleGenAI({ apiKey: Deno.env.get("GEMINI_API_KEY")! });

const RULES = [
  "당신은 익명 투표에 달린 코멘트를 '누가 썼는지 알 수 없게' 다듬는 편집자입니다.",
  "원문에는 작성자의 개인적인 말투가 그대로 드러납니다. 이것을 전형적인 AI 챗봇 말투로 다시 써 주세요.",
  "",
  "지켜야 할 것:",
  "- 원문의 주장과 근거는 그대로 유지합니다. 없는 내용을 새로 지어내지 않습니다.",
  "- 작성자를 특정할 수 있는 단서를 모두 지웁니다: 말버릇, 사투리, 줄임말, 은어, 이모지,",
  "  ㅋㅋ/ㅠㅠ 같은 자음 표기, 느낌표 남발, 특유의 문장부호, 본인만 아는 일화, 사람 이름.",
  "- 정중하고 균일한 '~습니다' 문어체로 씁니다.",
  `- 1~2문장, 공백 포함 ${OUT_CHARS}자 이내로 씁니다. 이 길이 제한은 반드시 지킵니다.`,
  "- 흔하고 무난한 어휘만 사용합니다.",
  "- 설명, 머리말, 따옴표 없이 변환된 코멘트 본문만 출력합니다.",
].join("\n");

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8" },
  });
}

/** 100자를 넘기면 문장 경계에서 자르고, 경계가 없으면 그냥 잘라냅니다. */
function clamp(s: string, max: number) {
  const chars = [...s];
  if (chars.length <= max) return s;
  const head = chars.slice(0, max).join("");
  const cut = Math.max(head.lastIndexOf("다."), head.lastIndexOf(". "), head.lastIndexOf("요."));
  return cut > max * 0.5 ? head.slice(0, cut + 2).trim() : head.trim() + "…";
}

function strip(s: string) {
  return s.trim().replace(/^["'“”「『]+/, "").replace(/["'“”」』]+$/, "").trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // 1) 신원 — 익명이라도 실제 Supabase 세션이 있어야 합니다.
  //    (anon key 자체도 유효한 JWT라서, 플랫폼의 verify_jwt 만으로는 아무나 부를 수 있습니다.)
  const authHeader = req.headers.get("Authorization") ?? "";
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);

  // 2) 입력
  const body = await req.json().catch(() => null);
  const text = strip(String(body?.text ?? ""));
  const place = String(body?.place ?? "").slice(0, 28);
  const roomCode = String(body?.roomCode ?? "").slice(0, 16);

  if (!text) return json({ error: "empty" }, 400);
  if ([...text].length > MAX_CHARS) return json({ error: "too_long", max: MAX_CHARS }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // 3) 실재하는 방인지 — 링크를 모르면 이 함수를 쓸 수 없습니다.
  const { data: room } = await admin.from("rooms").select("id").eq("code", roomCode).maybeSingle();
  if (!room) return json({ error: "no_room" }, 403);

  // 4) 레이트 리밋
  const { data: allowed, error: quotaErr } = await admin.rpc("consume_tone_quota", {
    p_user: user.id,
    p_limit: HOURLY_LIMIT,
  });
  if (quotaErr) return json({ error: "quota_check_failed" }, 500);
  if (!allowed) return json({ error: "rate_limited", limit: HOURLY_LIMIT }, 429);

  // --- 임시 진단 블록 (확인 후 제거) ---
  if (body?.__probe) {
    const k = Deno.env.get("GEMINI_API_KEY") ?? "";
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
      method: "POST",
      headers: { "x-goog-api-key": k, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, input: "say hi in korean, one word" }),
    });
    await r.text();
    const H = { "x-goog-api-key": k, "Content-Type": "application/json" };

    // 이 키로 실제 보이는 모델 목록
    const lr = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: H });
    const lj = await lr.json().catch(() => ({}));
    const available: string[] = (lj.models ?? []).map((m: { name: string }) => m.name);

    // 후보 모델 × 두 엔드포인트를 전수로 시도
    const candidates: string[] = body.__models ?? ["gemini-3.5-flash"];
    const tries: Array<Record<string, unknown>> = [];
    for (const m of candidates) {
      const a = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
        method: "POST", headers: H, body: JSON.stringify({ model: m, input: "안녕" }),
      });
      const at = await a.text();
      tries.push({ model: m, ep: "interactions", status: a.status, body: at.slice(0, 140) });

      const b = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: "POST", headers: H,
        body: JSON.stringify({ contents: [{ parts: [{ text: "안녕" }] }] }),
      });
      const bt = await b.text();
      tries.push({ model: m, ep: "generateContent", status: b.status, body: bt.slice(0, 140) });
    }

    return json({
      keyLen: k.length,
      keyPrefix: k.slice(0, 6),
      listModelsStatus: lr.status,
      availableCount: available.length,
      available: available.slice(0, 40),
      tries,
    });
  }

  // 5) 변환. 원문은 응답에도, 로그에도 남기지 않습니다.
  try {
    const interaction = await ai.interactions.create({
      model: MODEL,
      input: `여행지: ${place}\n원문: ${text}`,
      system_instruction: RULES,
      generation_config: { temperature: 0.7, maxOutputTokens: 400 },
    });

    // 안전 필터에 걸리거나 텍스트가 없으면 output_text 가 비어서 옵니다.
    const cleaned = clamp(strip(String(interaction.output_text ?? "")), OUT_CHARS);
    if (!cleaned) return json({ error: "empty_completion" }, 502);

    return json({ text: cleaned });
  } catch (e) {
    const status = (e as { status?: number })?.status;
    const msg = (e as Error)?.message ?? String(e);
    console.error("tone failed", status ?? "unknown", msg);   // 원문은 찍지 않습니다
    // 무료 티어는 분당 10회 / 하루 250회 상한이 있고, 둘 다 429 로 옵니다.
    if (status === 429) return json({ error: "upstream_rate_limited" }, 429);
    return json({ error: "upstream_failed", debug: msg.slice(0, 500) }, 502);
  }
});
