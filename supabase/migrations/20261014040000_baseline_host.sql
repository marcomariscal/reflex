-- The site each trusted wallet was paid or approved on. "Not the wallet this site usually uses" compares
-- against these trusted rows only, never pending holds.
alter table reflex.baselines add column host text;
-- Demo seed: the search API is the site the agent already pays.
update reflex.baselines set host = 'search.localhost' where agent_id = 'amp-demo' and recipient = '0x5ea7c0de00000000000000000000000000000001';
