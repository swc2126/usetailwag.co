const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const MESSAGE_LIMITS = { starter: 500, growth: 1500, pro: 5000 };

// GET /api/admin-report — full location report for owner/admin
router.get('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  if (!['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });

  const daycareId = req.daycareId;

  // Date helpers
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

  // ── Run all queries in parallel ──
  const [
    daycareRes,
    subRes,
    currentMsgsRes,
    allClientsRes,
    allDogsRes,
    teamRes,
    trendMsgsRes,
    trendClientsRes,
    trendReviewsReqRes,
    trendReviewsRecRes
  ] = await Promise.all([
    // Daycare info
    supabaseAdmin.from('daycares').select('name, city, state').eq('id', daycareId).single(),

    // Subscription / plan
    supabaseAdmin
      .from('subscriptions')
      .select('plan, status')
      .eq('daycare_id', daycareId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Current month messages
    supabaseAdmin
      .from('messages')
      .select('id, status, sender_id, created_at')
      .eq('daycare_id', daycareId)
      .gte('created_at', startOfMonth.toISOString()),

    // All active clients (includes review timestamps)
    supabaseAdmin
      .from('clients')
      .select('id, created_at, review_requested_at, review_received_at')
      .eq('daycare_id', daycareId)
      .eq('active', true),

    // Active dog count
    supabaseAdmin
      .from('dogs')
      .select('id', { count: 'exact', head: true })
      .eq('daycare_id', daycareId)
      .eq('active', true),

    // Team members
    supabaseAdmin
      .from('team_members')
      .select('id, user_id, role, invited_email')
      .eq('daycare_id', daycareId)
      .eq('status', 'active'),

    // Last 6 months of messages (for trend)
    supabaseAdmin
      .from('messages')
      .select('created_at, status')
      .eq('daycare_id', daycareId)
      .gte('created_at', sixMonthsAgo.toISOString()),

    // All clients created (for new-clients-per-month trend)
    supabaseAdmin
      .from('clients')
      .select('created_at')
      .eq('daycare_id', daycareId)
      .gte('created_at', sixMonthsAgo.toISOString()),

    // Review requests sent (for trend)
    supabaseAdmin
      .from('clients')
      .select('review_requested_at')
      .eq('daycare_id', daycareId)
      .not('review_requested_at', 'is', null)
      .gte('review_requested_at', sixMonthsAgo.toISOString()),

    // Reviews received (for trend)
    supabaseAdmin
      .from('clients')
      .select('review_received_at')
      .eq('daycare_id', daycareId)
      .not('review_received_at', 'is', null)
      .gte('review_received_at', sixMonthsAgo.toISOString())
  ]);

  const daycare = daycareRes.data || {};
  const plan = subRes.data?.plan?.toLowerCase() || 'starter';
  const messageLimit = MESSAGE_LIMITS[plan] || 500;
  const clients = allClientsRes.data || [];
  const teamMembers = teamRes.data || [];

  // ── Current month stats ──
  const currentMsgs = currentMsgsRes.data || [];
  const newClientsThisMonth = clients.filter(c =>
    new Date(c.created_at) >= startOfMonth
  ).length;
  const reviewRequestsThisMonth = clients.filter(c =>
    c.review_requested_at && new Date(c.review_requested_at) >= startOfMonth
  ).length;
  const reviewsReceivedThisMonth = clients.filter(c =>
    c.review_received_at && new Date(c.review_received_at) >= startOfMonth
  ).length;

  // ── Staff usage this month ──
  const senderCounts = {};
  currentMsgs.forEach(m => {
    if (m.sender_id) senderCounts[m.sender_id] = (senderCounts[m.sender_id] || 0) + 1;
  });

  // Fetch profiles for sender IDs
  const senderIds = Object.keys(senderCounts);
  let profileMap = {};
  if (senderIds.length) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, email')
      .in('id', senderIds);
    if (profiles) profiles.forEach(p => { profileMap[p.id] = p; });
  }

  const staffUsage = teamMembers
    .map(m => {
      const profile = m.user_id ? profileMap[m.user_id] : null;
      const name = profile
        ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || profile.email
        : (m.invited_email || 'Unknown');
      return {
        name,
        role: m.role,
        messages_this_month: m.user_id ? (senderCounts[m.user_id] || 0) : 0
      };
    })
    .sort((a, b) => b.messages_this_month - a.messages_this_month);

  // ── 6-month trend ──
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      messages: 0,
      new_clients: 0,
      review_requests: 0,
      reviews_received: 0
    });
  }
  const monthMap = {};
  months.forEach(m => { monthMap[m.key] = m; });

  (trendMsgsRes.data || []).forEach(m => {
    const key = m.created_at.substring(0, 7);
    if (monthMap[key]) monthMap[key].messages++;
  });
  (trendClientsRes.data || []).forEach(c => {
    const key = c.created_at.substring(0, 7);
    if (monthMap[key]) monthMap[key].new_clients++;
  });
  (trendReviewsReqRes.data || []).forEach(c => {
    const key = c.review_requested_at.substring(0, 7);
    if (monthMap[key]) monthMap[key].review_requests++;
  });
  (trendReviewsRecRes.data || []).forEach(c => {
    const key = c.review_received_at.substring(0, 7);
    if (monthMap[key]) monthMap[key].reviews_received++;
  });

  res.json({
    daycare: { ...daycare, plan, message_limit: messageLimit },
    current_month: {
      messages_sent: currentMsgs.length,
      messages_delivered: currentMsgs.filter(m => m.status === 'delivered').length,
      messages_failed: currentMsgs.filter(m => m.status === 'failed').length,
      message_limit: messageLimit,
      new_clients: newClientsThisMonth,
      review_requests_sent: reviewRequestsThisMonth,
      reviews_received: reviewsReceivedThisMonth
    },
    totals: {
      active_clients: clients.length,
      active_dogs: allDogsRes.count || 0,
      reviews_received_all_time: clients.filter(c => c.review_received_at).length,
      review_requests_all_time: clients.filter(c => c.review_requested_at).length
    },
    monthly_trend: months,
    staff_usage: staffUsage
  });
});

module.exports = router;
