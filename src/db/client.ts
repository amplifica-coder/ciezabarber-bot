import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

// Usa la service role key: el bot es el backend de confianza (no un
// cliente público), y necesita leer/escribir citas y clientes sin las
// restricciones de RLS pensadas para el sitio público o el panel admin.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
