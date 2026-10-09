create table if not exists public.appointments (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null default '',
  phone       text not null default '',
  note        text not null default '',
  status      text not null default '',
  jy          integer not null,
  jm          integer not null,
  jd          integer not null,
  hour        integer not null,
  minute      integer not null,
  deleted     boolean not null default false,
  client_ts   bigint  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists appointments_user_updated_idx
  on public.appointments (user_id, updated_at);

create or replace function public.appointments_before_write()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.client_ts <= old.client_ts then
      return old;
    end if;
    new.user_id    := old.user_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_appointments_before_write on public.appointments;
create trigger trg_appointments_before_write
  before insert or update on public.appointments
  for each row execute function public.appointments_before_write();

alter table public.appointments enable row level security;

drop policy if exists "owner full access" on public.appointments;
create policy "owner full access"
  on public.appointments
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.appointments from anon;
grant select, insert, update, delete on public.appointments to authenticated;
