// Supabase 접속 정보.
// 두 값 모두 공개되어도 되는 값입니다. anon key 는 브라우저에서 쓰라고 만든 키이고,
// 실제 권한은 schema.sql 의 RLS 정책이 정합니다.
//
// !! GEMINI_API_KEY 는 절대 이 파일에 넣지 마세요. Edge Function 의 secret 으로만 둡니다.
window.TRIP_VOTE_CONFIG = {
  SUPABASE_URL: "https://zybubuulwwhjbugqfmnm.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5YnVidXVsd3doamJ1Z3FmbW5tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyMjI5MjAsImV4cCI6MjEwMzc5ODkyMH0.6OTalQwH5tqp809Lh4y2yrSixzauQnh8QUPU3XOeAEU"
};
