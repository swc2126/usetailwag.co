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

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`TailWag server running on port ${PORT}`);
});
