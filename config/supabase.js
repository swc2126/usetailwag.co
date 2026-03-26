const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

// Client for browser-side operations (uses anon key)
const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

// Admin client for server-side operations (uses service role key)
const supabaseAdmin = createClient(supabaseUrl || '', supabaseServiceKey || '');

module.exports = { supabase, supabaseAdmin };
