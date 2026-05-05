const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

router.get('/stats', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  // ── Time anchors (local-date for today/tomorrow, UTC ms for ranges) ──
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  // Start of this week (Mon=0)
  const weekStart = new Date(now);
  const dow = (weekStart.getDay() + 6) % 7; // 0..6 with Mon=0
  weekStart.setDate(weekStart.getDate() - dow);
  weekStart.setHours(0, 0, 0, 0);

  const _ld = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const todayLocal = _ld(now);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowLocal = _ld(tomorrow);

  const [
    clientsRes, dogsRes, messagesRes, daycareRes,
    clientsThisWeekRes, messagesLastMonthRes,
    recurringRes,
    todayApptsRes, tomorrowApptsRes,
    reviewsRequestedRes, reviewsPendingRes
  ] = await Promise.all([
    // Existing fields
    supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).eq('active', true),
    supabaseAdmin.from('dogs').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).eq('active', true),
    supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('daycares').select('name, city, state, google_link').eq('id', req.daycareId).single(),
    // Deltas
    supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).eq('active', true).gte('created_at', weekStart.toISOString()),
    supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).gte('created_at', lastMonthStart.toISOString()).lt('created_at', monthStart.toISOString()),
    // Distinct dog_ids on active recurring schedules — used for "X with recurring schedule"
    supabaseAdmin.from('recurring_schedules').select('dog_id').eq('daycare_id', req.daycareId).eq('active', true).not('dog_id', 'is', null),
    // Today's appointments — fetch full status list to bucket client-side (cheaper than 4 round-trips)
    supabaseAdmin.from('appointments').select('id, status').eq('daycare_id', req.daycareId).eq('appointment_date', todayLocal),
    // Tomorrow's pending appointments — used to populate "Coming up tomorrow"
    supabaseAdmin.from('appointments').select('id, status, notes, clients(first_name, last_name), dogs(name, breed)').eq('daycare_id', req.daycareId).eq('appointment_date', tomorrowLocal).eq('status', 'pending').order('id'),
    // Reviews (this month) + still awaiting parent action
    supabaseAdmin.from('review_requests').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('review_requests').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).eq('status', 'requested')
  ]);

  // Bucket today's appointments by status
  const todayCounts = { total: 0, confirmed: 0, pending: 0, cancelled: 0 };
  (todayApptsRes.data || []).forEach(a => {
    todayCounts.total++;
    if (a.status === 'confirmed')                                 todayCounts.confirmed++;
    else if (a.status === 'cancelled')                            todayCounts.cancelled++;
    else if (a.status === 'pending' || a.status === 'recurring_pending') todayCounts.pending++;
  });

  // Distinct dogs on a recurring schedule
  const dogsWithRecurring = new Set((recurringRes.data || []).map(r => r.dog_id)).size;

  // MoM message delta (percentage)
  const mLast = messagesLastMonthRes.count || 0;
  const mThis = messagesRes.count || 0;
  const messages_mom_pct = mLast > 0 ? Math.round(((mThis - mLast) / mLast) * 100) : null;

  res.json({
    // Existing keys (kept for backward compat)
    clients: clientsRes.count || 0,
    dogs: dogsRes.count || 0,
    messages_this_month: mThis,
    daycare: daycareRes.data,

    // New keys (all additive — old dashboards ignore these)
    clients_added_this_week: clientsThisWeekRes.count || 0,
    dogs_with_recurring: dogsWithRecurring,
    messages_last_month: mLast,
    messages_mom_pct,
    today_appointments: todayCounts,
    tomorrow_pending: tomorrowApptsRes.data || [],
    reviews_this_month: reviewsRequestedRes.count || 0,
    reviews_pending_response: reviewsPendingRes.count || 0
  });
});

// PUT /api/dashboard/daycare — update daycare settings
//
// Permission model:
// - Profile fields (name/phone/street/city/state/zip/google_link) are
//   super_admin-only. Owners/managers see them in Settings as read-only
//   and use the request-change flow below to ask Summer to update.
// - messaging_style / messaging_mode / auto_reply_text are operational
//   self-serve and remain editable for owner/manager (and super_admin/admin).
router.put('/daycare', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { name, phone, street, city, state, zip, google_link, messaging_style, messaging_mode, auto_reply_text } = req.body;

  const profileFieldsSent =
    name !== undefined || phone !== undefined || street !== undefined ||
    city !== undefined || state !== undefined || zip !== undefined ||
    google_link !== undefined;

  const operationalFieldsSent =
    messaging_style !== undefined || messaging_mode !== undefined || auto_reply_text !== undefined;

  // Profile fields: super_admin only
  if (profileFieldsSent && req.userRole !== 'super_admin') {
    return res.status(403).json({ error: 'Daycare profile changes are managed by TailWag staff. Use Request Changes to submit a request.' });
  }

  // Operational fields: existing role gate
  if (operationalFieldsSent && !['owner', 'manager', 'super_admin', 'admin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  // Validate URL if provided
  if (google_link) {
    try { new URL(google_link); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  }

  // Validate messaging_mode if provided
  if (messaging_mode !== undefined && !['one_way', 'two_way'].includes(messaging_mode)) {
    return res.status(400).json({ error: 'messaging_mode must be one_way or two_way' });
  }

  // Handle messaging_style separately — JSONB column added post-deploy;
  // update without .select() to avoid PostgREST schema cache conflicts
  if (messaging_style !== undefined) {
    const { error: msError } = await supabaseAdmin
      .from('daycares')
      .update({ messaging_style })
      .eq('id', req.daycareId);
    if (msError) return res.status(500).json({ error: msError.message });
  }

  const updates = {};
  if (name             !== undefined) updates.name             = name.trim();
  if (phone            !== undefined) updates.phone            = phone.trim();
  if (street           !== undefined) updates.street           = street.trim();
  if (city             !== undefined) updates.city             = city.trim();
  if (state            !== undefined) updates.state            = state.trim();
  if (zip              !== undefined) updates.zip              = zip.trim();
  if (google_link      !== undefined) updates.google_link      = google_link.trim() || null;
  if (messaging_mode   !== undefined) updates.messaging_mode   = messaging_mode;
  if (auto_reply_text  !== undefined) updates.auto_reply_text  = (auto_reply_text || '').trim() || null;

  // If only messaging_style was sent, return success now
  if (Object.keys(updates).length === 0) {
    return res.json({ ok: true });
  }

  const { data, error } = await supabaseAdmin
    .from('daycares')
    .update(updates)
    .eq('id', req.daycareId)
    .select('name, phone, street, city, state, zip, google_link, messaging_mode, auto_reply_text');

  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Daycare not found or no rows updated' });
  res.json(data[0]);
});

// POST /api/dashboard/daycare/request-change — owner/manager flow for
// requesting an edit to daycare profile. Sends an email to summer@usetailwag.co
// with the current values + the requester's free-text request.
router.post('/daycare/request-change', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const message = (req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (message.length > 4000) return res.status(400).json({ error: 'Message too long' });

  // Pull current daycare values + requester profile in parallel so the email
  // includes the as-of-now state Summer is being asked to change.
  const [{ data: dc }, { data: profile }] = await Promise.all([
    supabaseAdmin
      .from('daycares')
      .select('name, phone, street, city, state, zip, google_link')
      .eq('id', req.daycareId)
      .single(),
    supabaseAdmin
      .from('profiles')
      .select('first_name, last_name, email')
      .eq('id', req.user.id)
      .single()
  ]);

  if (!dc) return res.status(404).json({ error: 'Daycare not found' });

  const requesterName = profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() : '';
  const requesterEmail = profile?.email || req.user.email || '';
  const escape = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const html = `
    <p>A daycare owner submitted a profile change request:</p>
    <p><strong>${escape(requesterName) || 'Unknown user'}</strong> &lt;${escape(requesterEmail)}&gt;<br>
    Daycare: <strong>${escape(dc.name)}</strong> (${escape([dc.city, dc.state].filter(Boolean).join(', ') || 'no address on file')})<br>
    Role: ${escape(req.userRole)}</p>

    <h3 style="margin-top:24px;font-size:14px;text-transform:uppercase;color:#666;letter-spacing:0.06em;">Current values</h3>
    <table style="border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:4px 12px 4px 0;color:#888;">Name</td><td>${escape(dc.name)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888;">Phone</td><td>${escape(dc.phone) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888;">Street</td><td>${escape(dc.street) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888;">City / State / ZIP</td><td>${escape([dc.city, dc.state, dc.zip].filter(Boolean).join(' · ')) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#888;">Google review link</td><td>${escape(dc.google_link) || '—'}</td></tr>
    </table>

    <h3 style="margin-top:24px;font-size:14px;text-transform:uppercase;color:#666;letter-spacing:0.06em;">Requested change</h3>
    <pre style="white-space:pre-wrap;font-family:inherit;background:#f5f0e8;padding:14px;border-radius:8px;border:1px solid rgba(0,0,0,0.08);">${escape(message)}</pre>

    <p style="font-size:12px;color:#999;margin-top:24px;">Reply directly to this email to follow up — it will go to ${escape(requesterEmail) || 'the requester'}.</p>
  `;

  try {
    const { sendEmail } = require('../utils/email');
    await sendEmail({
      to: 'summer@usetailwag.co',
      subject: `[TailWag] Daycare change request from ${dc.name}`,
      html
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[daycare/request-change] email send failed:', err.message);
    res.status(500).json({ error: 'Could not send request — please email summer@usetailwag.co directly.' });
  }
});

module.exports = router;
