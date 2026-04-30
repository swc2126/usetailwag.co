require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook needs raw body — must be registered before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Telnyx webhooks need raw body for Ed25519 signature verification
app.use('/api/sms/telnyx/status', express.raw({ type: 'application/json' }));
app.use('/api/sms/telnyx/inbound', express.raw({ type: 'application/json' }));

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
const analyticsRouter = require('./routes/analytics');
app.use('/api/analytics', analyticsRouter);

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Clean URL for newsletter landing page
app.get('/chew-on-this', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chew-on-this.html'));
});

// Gingr import tool
app.get('/gingr-import', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gingr-import.html')));

// Legal pages
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// Signup → request access page
app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// Private account creation link (sent to paying customers only)
app.get('/create-account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create-account.html'));
});

// New account setup page — for paying customers linked to existing daycare
app.get('/new-account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'new-account.html'));
});

// Insights dashboard — role-based analytics for all users
app.get('/insights', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'insights.html'));
});

// Resources hub — help, downloads, onboarding
app.get('/resources', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'resources.html'));
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
const { supabaseAdmin } = require('./config/supabase');
const { sendSms } = require('./utils/telnyx');

cron.schedule('*/10 * * * *', async () => {
  try {
    const { data: pending } = await supabaseAdmin
      .from('pending_followups')
      .select('*')
      .eq('sent', false)
      .lte('send_at', new Date().toISOString())
      .limit(50);

    if (!pending?.length) return;

    for (const followup of pending) {
      try {
        const { data: config } = await supabaseAdmin
          .from('messaging_config')
          .select('phone_number')
          .eq('daycare_id', followup.daycare_id)
          .eq('status', 'active')
          .single();

        if (!config?.phone_number) continue;

        await sendSms({
          from: config.phone_number,
          to: followup.recipient_phone,
          text: followup.followup_body
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


// ─── CRON: Daily appointment reminders at 6 PM CT ────────────────────────────
//
// For every daycare with an active phone number:
//   - Per-visit reminders for tomorrow's pending appointments
//   - Weekly summaries (Sundays only) for clients on weekly_summary cadence
//
// node-cron's `timezone` option handles DST automatically — fires at 6 PM
// America/Chicago year-round. Each daycare's send is wrapped in try/catch
// so one failure doesn't poison the rest of the run.
const { runDailyReminders, runWeeklySummaries } = require('./routes/appointments');

cron.schedule('0 18 * * *', async () => {
  try {
    const { data: configs } = await supabaseAdmin
      .from('messaging_config')
      .select('daycare_id')
      .eq('status', 'active');
    if (!configs?.length) {
      console.log('[reminder-cron] No active daycares — skipping');
      return;
    }

    const tomorrow = new Date(Date.now() + 86400_000).toISOString().split('T')[0];
    const isSunday = new Date().toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Chicago' }) === 'Sun';

    let totalPV = 0, totalWS = 0, errors = 0;
    for (const cfg of configs) {
      try {
        const r = await runDailyReminders(cfg.daycare_id, tomorrow);
        totalPV += r.sent || 0;
      } catch (err) {
        errors++;
        console.error(`[reminder-cron] PV ${cfg.daycare_id}:`, err.message);
      }
      if (isSunday) {
        try {
          const r = await runWeeklySummaries(cfg.daycare_id);
          totalWS += r.sent || 0;
        } catch (err) {
          errors++;
          console.error(`[reminder-cron] WS ${cfg.daycare_id}:`, err.message);
        }
      }
    }

    console.log(`[reminder-cron] sent ${totalPV} per-visit + ${totalWS} weekly summaries across ${configs.length} daycares (errors: ${errors})${isSunday ? '' : ' [non-Sunday — weekly skipped]'}`);
  } catch (err) {
    console.error('Reminder cron error:', err.message);
  }
}, { timezone: 'America/Chicago' });


// ─── CRON: Daily phone inventory check at 8am CT (13:00 UTC) ─────────────────
const { getNumberInventory, INVENTORY_THRESHOLD } = require('./routes/ceo');
const { sendEmail } = require('./utils/email');
const INVENTORY_ALERT_TO = 'summer@usetailwag.co';

cron.schedule('0 13 * * *', async () => {
  try {
    const inv = await getNumberInventory();
    if (!inv.low_area_codes.length) {
      console.log('[inventory-cron] All area codes healthy — no alert sent');
      return;
    }

    const lowRows = inv.low_area_codes.map(ac => {
      const b = inv.by_area_code[ac];
      const flag = b.available === 0 ? '🚨' : '⚠️';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;"><strong>${ac}</strong> ${flag}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${b.available}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:#888;">${b.in_use}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:#888;">${b.on_profile}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:#888;">${b.purchased}</td>
      </tr>`;
    }).join('');

    const allRows = inv.target_area_codes.map(ac => {
      const b = inv.by_area_code[ac];
      const isLow = b.available < INVENTORY_THRESHOLD;
      const bgColor = b.available === 0 ? '#FEE7E7' : isLow ? '#FEF6E7' : 'transparent';
      return `<tr style="background:${bgColor};">
        <td style="padding:8px 12px;border-bottom:1px solid #eee;"><strong>${ac}</strong></td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;"><strong>${b.available}</strong></td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:#888;">${b.in_use}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:#888;">${b.on_profile}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:#888;">${b.purchased}</td>
      </tr>`;
    }).join('');

    const subject = `TailWag — phone inventory low: ${inv.low_area_codes.length} area code${inv.low_area_codes.length === 1 ? '' : 's'} need attention`;
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#F5F0E8;font-family:Inter,Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;"><tr><td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
          <tr><td style="background:#0F1410;padding:24px 32px;color:#F5F0E8;">
            <span style="font-weight:800;font-size:20px;">🐾 TailWag</span>
            <div style="font-size:13px;color:#A8C5B0;margin-top:4px;">Phone Inventory Alert</div>
          </td></tr>
          <tr><td style="padding:32px;">
            <h2 style="margin:0 0 8px;color:#0F1410;font-size:18px;">Inventory needs topping up</h2>
            <p style="color:#555;font-size:14px;margin:0 0 24px;">Below threshold of ${INVENTORY_THRESHOLD} available numbers per area code:</p>

            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-bottom:24px;">
              <thead><tr style="background:#FEF6E7;">
                <th style="padding:10px 12px;text-align:left;border-bottom:2px solid #C4933F;">Area Code</th>
                <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #C4933F;">Available</th>
                <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #C4933F;color:#888;">In Use</th>
                <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #C4933F;color:#888;">On Profile</th>
                <th style="padding:10px 12px;text-align:center;border-bottom:2px solid #C4933F;color:#888;">Purchased</th>
              </tr></thead>
              <tbody>${lowRows}</tbody>
            </table>

            <h3 style="margin:24px 0 8px;color:#0F1410;font-size:15px;">Full inventory snapshot</h3>
            <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;margin-bottom:24px;">
              <thead><tr style="background:#f5f0e8;">
                <th style="padding:10px 12px;text-align:left;border-bottom:1px solid #ddd;">Area Code</th>
                <th style="padding:10px 12px;text-align:center;border-bottom:1px solid #ddd;">Available</th>
                <th style="padding:10px 12px;text-align:center;border-bottom:1px solid #ddd;">In Use</th>
                <th style="padding:10px 12px;text-align:center;border-bottom:1px solid #ddd;">On Profile</th>
                <th style="padding:10px 12px;text-align:center;border-bottom:1px solid #ddd;">Purchased</th>
              </tr></thead>
              <tbody>${allRows}</tbody>
            </table>

            <p style="font-size:13px;color:#555;line-height:1.6;margin:0 0 16px;">
              <strong>To replenish:</strong> Buy numbers in Telnyx Portal → Numbers → Search & Buy. Then (1) attach to messaging profile <em>TailWag</em>, and (2) add to campaign <code>C4FBXUV</code>. Carriers take ~24h to approve.
            </p>

            <table cellpadding="0" cellspacing="0"><tr><td style="background:#1E6B4A;border-radius:8px;">
              <a href="https://usetailwag.co/ceo" style="display:inline-block;padding:12px 24px;color:#F5F0E8;text-decoration:none;font-size:14px;font-weight:600;">Open CEO Dashboard →</a>
            </td></tr></table>
          </td></tr>
        </table>
      </td></tr></table>
    </body></html>`;

    await sendEmail({ to: INVENTORY_ALERT_TO, subject, html });
    console.log(`[inventory-cron] Alert sent — low: ${inv.low_area_codes.join(', ')}`);
  } catch (err) {
    console.error('[inventory-cron] Error:', err.message);
  }
});
