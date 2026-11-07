/* Connection settings for this deployment — the ONLY place they live.
   These are the project's PUBLIC client values (the project URL and its publishable key). A static website has to
   ship them to the browser, so they can't be secret; what protects the data is the database's row-level security
   and each person's own login. Never put a secret key (service_role), a password or a connection string here.
   Leave a value empty to make every device enter its own in Settings. */
window.DOCKLINE_CONFIG = {
  supabaseUrl: 'https://flhwqqblybrmargalgld.supabase.co/rest/v1',
  supabaseKey: 'sb_publishable_VJtbFCSJSkCymNi2V_hl1g_gRUzDmX6'
};
