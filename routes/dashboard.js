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
router.put('/daycare', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  if (!['owner', 'manager', 'super_admin', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });

  const { name, phone, street, city, state, zip, google_link, messaging_style, messaging_mode, auto_reply_text } = req.body;

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

module.exports = router;
