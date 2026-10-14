-- Agents whose key is handed out (the guest key for judges) may only make test payments. The scorer
-- refuses any non-stub challenge for them, so a shared key can't get real Tempo payments signed.
alter table reflex.agents add column if not exists test_only boolean not null default false;
update reflex.agents set test_only = true where id in ('guest', 'judge');
