import { createClient } from "@supabase/supabase-js";

/** Public client — anon key, for reads */
export function getPublicClient(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
}

/** Service client — service role key, for writes */
export function getServiceClient(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
}
