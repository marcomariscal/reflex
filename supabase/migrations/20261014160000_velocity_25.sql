-- The demo runs at 25 payments a minute: a brief with a dozen searches tripped 10, so the live
-- project was tuned to 25. Fresh projects match the README and the recorded demo.
alter table reflex.agents alter column velocity_limit set default 25;
update reflex.agents set velocity_limit = 25 where velocity_limit = 10;
