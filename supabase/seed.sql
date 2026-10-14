-- Demo seed: agent amp-demo with LEGIT as its only baselined payee.
-- key_hash differs per environment, so it starts as a placeholder no key can
-- match. Set it after seeding (prints nothing secret, only the hash):
--
--   hash=$(grep '^REFLEX_AGENT_KEY=' .env | cut -d= -f2- | tr -d '\n' | shasum -a 256 | cut -d' ' -f1)
--   psql "$DB_URL" -c "update reflex.agents set key_hash = '$hash' where id = 'amp-demo'"
--
-- Rerunnable. POST /reflex-score/admin/reset restores this baseline later.

insert into reflex.agents (id, key_hash)
values ('amp-demo', 'unset:amp-demo')
on conflict (id) do nothing;

insert into reflex.baselines (agent_id, recipient, max_usd, seed_max_usd, source)
values ('amp-demo', '0x5ea7c0de00000000000000000000000000000001', 0.05, 0.05, 'seed')
on conflict (agent_id, recipient) do update
  set max_usd = excluded.max_usd, seed_max_usd = excluded.seed_max_usd, source = 'seed',
      payment_count = 0, last_paid_at = null;
