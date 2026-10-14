-- Explicit deny-all for API roles. The schema is already private and RLS is on;
-- this states the intent and clears advisor lint 0008 (RLS enabled, no policy).
create policy no_api_access on reflex.agents for all to anon, authenticated using (false) with check (false);
create policy no_api_access on reflex.baselines for all to anon, authenticated using (false) with check (false);
create policy no_api_access on reflex.payments for all to anon, authenticated using (false) with check (false);
create policy no_api_access on reflex.holds for all to anon, authenticated using (false) with check (false);
