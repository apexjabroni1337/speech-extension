// ============================================================
// PASTE YOUR SUPABASE KEYS HERE
// Supabase dashboard -> Project Settings -> API
//   - Project URL        -> SUPABASE_URL
//   - anon / public key  -> SUPABASE_ANON_KEY
// The anon key is safe to ship in a client; Row Level Security
// in schema.sql is what protects the data.
// ============================================================
const CONFIG = {
  SUPABASE_URL: "https://cvrkvxmhsdzweikvrnxo.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2cmt2eG1oc2R6d2Vpa3ZybnhvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwOTA2MjAsImV4cCI6MjA5NjY2NjYyMH0._opqu4NE_5Wx0C4IK4czHrVRcZJ7wWhX2aOurkOtYOc",
  // Public website URL (profiles, threads, global feed).
  // Set to "" to fall back to the site bundled inside the extension (site.html).
  WEBSITE_URL: "https://apexjabroni1337.github.io/speech-site/",
  // "Become a Supporter" checkout link (e.g. a Stripe Payment Link).
  // Leave "" until you have one; the button explains it's coming soon.
  SUPPORT_URL: ""
};
