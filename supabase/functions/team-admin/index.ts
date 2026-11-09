// DRAFT FOR REVIEW — NOT DEPLOYED. Admin-only account management for Dockline's Team page (js/26-roles.js → teamCall()).
// Deploy (after review):  supabase functions deploy team-admin     (leave "Verify JWT" ON)
// The service-role key is provided to the function by Supabase as an environment variable; it never goes into the app or this repo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",   // the app is served from github.io; every call still needs a valid admin login
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const url = Deno.env.get("SUPABASE_URL")!, service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, service, { auth: { persistSession: false } });

  // who is calling? Read their account fresh (not from the possibly stale token) and require role = admin
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json(401, { error: "Not signed in" });
  if (who.user.app_metadata?.role !== "admin") return json(403, { error: "Only an admin can manage people" });
  const me = who.user.id;

  let body: any; try { body = await req.json(); } catch { return json(400, { error: "Bad request" }); }
  const roleExists = async (id: string) => {
    const { data } = await admin.from("records").select("id").eq("store", "roles").eq("id", id).eq("deleted", false).maybeSingle();
    return !!data;
  };

  try {
    switch (body.action) {
      case "list": {
        const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
        if (error) throw error;
        return json(200, { users: data.users.map((u) => ({
          id: u.id, email: u.email, role: u.app_metadata?.role === "admin" ? "admin" : "staff",
          role_id: u.app_metadata?.role_id || "", last_sign_in_at: u.last_sign_in_at })) });
      }
      case "create": {
        const { email, password, role_id } = body;
        if (!/^\S+@\S+\.\S+$/.test(email || "")) return json(400, { error: "Invalid email" });
        if (!password || String(password).length < 8) return json(400, { error: "Password must be at least 8 characters" });
        if (!role_id || !(await roleExists(role_id))) return json(400, { error: "Unknown role" });
        const { data, error } = await admin.auth.admin.createUser({
          email, password, email_confirm: true, app_metadata: { role: "staff", role_id } });
        if (error) return json(400, { error: error.message });
        return json(200, { id: data.user?.id });
      }
      case "setRole": {
        const { user_id, role_id } = body;
        if (user_id === me) return json(400, { error: "You cannot change your own role" });
        const { data: t } = await admin.auth.admin.getUserById(user_id);
        if (!t?.user) return json(404, { error: "No such person" });
        if (t.user.app_metadata?.role === "admin") return json(400, { error: "Admins are changed in the Supabase dashboard" });
        if (role_id && !(await roleExists(role_id))) return json(400, { error: "Unknown role" });
        const { error } = await admin.auth.admin.updateUserById(user_id, { app_metadata: { ...t.user.app_metadata, role: "staff", role_id: role_id || "" } });
        if (error) throw error;
        return json(200, { ok: true });
      }
      case "setPassword": {
        const { user_id, password } = body;
        if (!password || String(password).length < 8) return json(400, { error: "Password must be at least 8 characters" });
        const { data: t } = await admin.auth.admin.getUserById(user_id);
        if (t?.user?.app_metadata?.role === "admin" && user_id !== me) return json(400, { error: "Admins' passwords are changed in the Supabase dashboard" });
        const { error } = await admin.auth.admin.updateUserById(user_id, { password });
        if (error) throw error;
        return json(200, { ok: true });
      }
      case "remove": {
        const { user_id } = body;
        if (user_id === me) return json(400, { error: "You cannot remove yourself" });
        const { data: t } = await admin.auth.admin.getUserById(user_id);
        if (t?.user?.app_metadata?.role === "admin") return json(400, { error: "Admins are removed in the Supabase dashboard" });
        const { error } = await admin.auth.admin.deleteUser(user_id);
        if (error) throw error;
        return json(200, { ok: true });
      }
      default: return json(400, { error: "Unknown action" });
    }
  } catch (e) {
    return json(500, { error: String((e as Error).message || e) });
  }
});
