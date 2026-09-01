-- 008: 표에 낸 사람을 기록
--   지금까지는 표를 익명으로 두어 서버조차 누가 냈는지 몰랐습니다.
--   그 대신 "내 표 고치기" 가 표를 낸 기기에서만 가능했습니다.
--   이제 client_id 를 붙여 어느 기기에서든 본인 표를 고칠 수 있게 합니다.
--
--   주의: 화면에서만 익명입니다. ballots 는 로그인한 사람이면 읽을 수 있으므로,
--   API 를 직접 조회하면 누가 어디에 투표했는지 알 수 있습니다.

alter table public.ballots add column if not exists client_id text;
create index if not exists ballots_owner_idx on public.ballots(room_id, round, client_id);
