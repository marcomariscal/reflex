import postgres from "npm:postgres@3.4.5";

// One connection per request; callers end it in `finally`. SUPABASE_DB_URL is a
// direct connection (max_connections = 60) and the hosted runtime often boots a
// fresh worker per request, so a per-worker pool would park one idle backend per
// call and a 50-call loop could exhaust the database.
export const connect = () =>
  postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, connect_timeout: 10 });

export type Sql = ReturnType<typeof connect>;
