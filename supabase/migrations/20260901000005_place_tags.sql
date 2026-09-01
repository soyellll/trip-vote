-- 005: 여행지 태그
--   "#맛집 #부르주아" 처럼 여행지에 붙이는 공개 태그입니다.
--   투표할 때 다는 익명 코멘트와는 별개로, 누구나 덧붙일 수 있는 공동 메모입니다.

alter table public.places add column if not exists tags jsonb not null default '[]'::jsonb;
