import { createClient } from "@supabase/supabase-js"
// Preserved component data sources must be adapted to a scoped BFF server API.
export const supabase = createClient("http://localhost", "bff-server-only", { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async () => { throw new Error("此组件的数据源尚未接入 BFF 服务") } } })
