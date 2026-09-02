-- 010: 삭제 코드
--   방을 지우거나 참가자 표를 초기화할 때 4자리 숫자를 요구합니다.
--   오탭으로 데이터가 통째로 날아가는 걸 막는 게 목적입니다.
--   (API 를 직접 조회하면 코드도 보입니다. 실수 방지용이지 보안 장치가 아닙니다.)

alter table public.rooms add column if not exists delete_code text;
alter table public.rooms drop constraint if exists rooms_delete_code_check;
alter table public.rooms add constraint rooms_delete_code_check
  check (delete_code is null or delete_code ~ '^[0-9]{4}$');
