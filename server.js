require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook needs raw body — must be registered before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Twilio status callback uses urlencoded
app.use('/api/sms/status', express.urlencoded({ extended: false }));

// Parse JSON bodies
app.use(express.json());

// Short link redirects — must be before static middleware
app.get('/r/:code', async (req, res) => {
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase
    .from('short_links')
    .select('original_url, clicks, id')
    .eq('code', req.params.code.toUpperCase())
    .single();

  if (error || !data) {
    return res.status(404).send(`
      <!DOCTYPE html><html><head><title>Link not found — TailWag</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:60px;">
        <h2>🐾 Link not found</h2>
        <p>This link may have expired or been removed.</p>
        <a href="https://usetailwag.co">Visit TailWag</a>
      </body></html>
    `);
  }

  // Increment click count (fire and forget)
  supabase.from('short_links').update({ clicks: (data.clicks || 0) + 1 }).eq('id', data.id).then(() => {});

  res.redirect(301, data.original_url);
});

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/stripe', require('./routes/stripe'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/dogs', require('./routes/dogs'));
app.use('/api/team', require('./routes/team'));
app.use('/api/sms', require('./routes/sms'));
app.use('/api/media', require('./routes/media'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/reviews', require('./routes/reviews'));
app.use('/api/shortlinks', require('./routes/shortlinks'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/ceo', require('./routes/ceo'));
app.use('/api/admin-report', require('./routes/admin-report'));
app.use('/api/appointments', require('./routes/appointments'));
app.use('/api/import', require('./routes/import'));
app.use('/api/newsletter', require('./routes/newsletter'));
app.use('/api/sentiment', require('./routes/sentiment'));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Clean URL for newsletter landing page
app.get('/chew-on-this', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chew-on-this.html'));
});

// Legal pages
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// Signup clean URL (preserves ?plan= query param)
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// CEO dashboard — protected route, redirects to login if no token present
app.get('/ceo', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1] || req.cookies?.tailwag_token;
  // Client-side auth check handles redirect; serve the file and let JS enforce access
  res.sendFile(path.join(__dirname, 'public', 'ceo-dashboard.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`TailWag server running on port ${PORT}`);
});


// ─── CRON: Send pending sentiment follow-ups every 10 minutes ───────────────
const cron = require('node-cron');
const twilio = require('twilio');
const { supabaseAdmin } = require('./config/supabase');

cron.schedule('*/10 * * * *', async () => {
  try {
    const { data: pending } = await supabaseAdmin
      .from('pending_followups')
      .select('*, twilio_config:daycares(twilio_config(phone_number))')
      .eq('sent', false)
      .lte('send_at', new Date().toISOString())
      .limit(50);

    if (!pending?.length) return;

    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    for (const followup of pending) {
      try {
        // Get the TailWag number for this daycare
        const { data: twilioConfig } = await supabaseAdmin
          .from('twilio_config')
          .select('phone_number')
          .eq('daycare_id', followup.daycare_id)
          .eq('status', 'active')
          .single();

        if (!twilioConfig?.phone_number) continue;

        await twilioClient.messages.create({
          from: twilioConfig.phone_number,
          to: followup.recipient_phone,
          body: followup.followup_body
        });

        await supabaseAdmin
          .from('pending_followups')
          .update({ sent: true, sent_at: new Date().toISOString() })
          .eq('id', followup.id);

        console.log(`✅ Sent follow-up to ${followup.recipient_phone}`);
      } catch (err) {
        console.error(`Follow-up send error for ${followup.recipient_phone}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Cron follow-up error:', err.message);
  }
});
