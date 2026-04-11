const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const PLAN_MRR = { starter: 99, growth: 179, partner: 249 };

// GET /api/ceo/overview
router.get('/overview', requireAuth, requireRole('super_admin', 'owner', 'manager'), async (req, res) => {
  try {
    console.log('[CEO] overview hit — userId:', req.user?.id, 'role:', req.userRole);

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let daycares, dcError;

    if (req.userRole === 'super_admin') {
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, street, city, state, zip, phone, google_link, owner_id, created_at')
        .order('name'));
    } else if (req.userRole === 'owner') {
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, street, city, state, zip, phone, google_link, owner_id, created_at')
        .eq('owner_id', req.user.id)
        .order('name'));
    } else if (req.userRole === 'manager') {
      const { data: assignments } = await supabaseAdmin
        .from('team_members')
        .select('daycare_id')
        .eq('user_id', req.user.id)
        .eq('status', 'active');
      const ids = (assignments || []).map(a => a.daycare_id);
      if (!ids.length) {
        return res.json({
          role: req.userRole,
          totals: { locations: 0, new_30d: 0, clients: 0, dogs: 0, messages_30d: 0, mrr: 0, inactive_14d: 0, zero_usage_7d: 0, avg_tenure_days: 0 },
          plan_distribution: { starter: 0, growth: 0, partner: 0, none: 0 },
          status_distribution: { active: 0, past_due: 0, canceled: 0, none: 0 },
          state_distribution: [],
          locations: []
        });
      }
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, street, city, state, zip, phone, google_link, owner_id, created_at')
        .in('id', ids)
        .order('name'));
    }

    console.log('[CEO] daycares found:', daycares?.length ?? 0, '| error:', dcError?.message ?? null);
    if (dcError) {
      console.error('CEO daycares query error:', dcError.message);
      return res.status(500).json({ error: dcError.message });
    }
    if (!daycares || !daycares.length) {
      return res.json({
        role: req.userRole,
        totals: { locations: 0, new_30d: 0, clients: 0, dogs: 0, messages_30d: 0, mrr: 0, inactive_14d: 0, zero_usage_7d: 0, avg_tenure_days: 0 },
        plan_distribution: { starter: 0, growth: 0, partner: 0, none: 0 },
        status_distribution: { active: 0, past_due: 0, canceled: 0, none: 0 },
        state_distribution: [],
        locations: []
      });
    }

    // Collect all unique owner_ids to bulk-fetch profiles and subscriptions
    const ownerIds = [...new Set(daycares.map(dc => dc.owner_id).filter(Boolean))];

    const [{ data: profiles }, { data: allSubs }] = await Promise.all([
      supabaseAdmin
        .from('profiles')
        .select('id, first_name, last_name, email')
        .in('id', ownerIds),
      supabaseAdmin
        .from('subscriptions')
        .select('user_id, status, plan, billing_cycle')
        .in('user_id', ownerIds)
    ]);

    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    const subMap = {};
    (allSubs || []).forEach(s => { subMap[s.user_id] = s; });

    console.log('[CEO] profiles fetched:', profiles?.length ?? 0, '| subs fetched:', allSubs?.length ?? 0);

    // Fetch per-daycare stats in parallel
    const locationStats = await Promise.all(
      daycares.map(async (dc) => {
        const [clientsRes, dogsRes, teamRes, msgs30Res, msgs7Res, lastMsgRes] = await Promise.all([
          supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('active', true),
          supabaseAdmin.from('dogs').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('active', true),
          supabaseAdmin.from('team_members').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('status', 'active'),
          supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).gte('created_at', thirtyDaysAgo),
          supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).gte('created_at', sevenDaysAgo),
          supabaseAdmin.from('messages').select('created_at').eq('daycare_id', dc.id).order('created_at', { ascending: false }).limit(1)
        ]);

        const owner = profileMap[dc.owner_id] || {};
        const sub = subMap[dc.owner_id] || null;

        const lastMsgAt = lastMsgRes.data?.[0]?.created_at || null;
        const msgs30d = msgs30Res.count || 0;
        const msgs7d = msgs7Res.count || 0;

        const daysSinceLastMsg = lastMsgAt
          ? Math.floor((now - new Date(lastMsgAt)) / (1000 * 60 * 60 * 24))
          : null;

        const createdAt = dc.created_at ? new Date(dc.created_at) : null;
        const daysSinceSignup = createdAt
          ? Math.floor((now - createdAt) / (1000 * 60 * 60 * 24))
          : 0;

        const isActiveSub = sub?.status === 'active';
        const isInactive14d = isActiveSub && (daysSinceLastMsg === null || daysSinceLastMsg >= 14);
        const isZero7d = isActiveSub && msgs7d === 0;

        const plan = (sub?.plan || '').toLowerCase();
        const mrr = PLAN_MRR[plan] || 0;

        return {
          id: dc.id,
          name: dc.name,
          street: dc.street,
          city: dc.city,
          state: dc.state,
          zip: dc.zip,
          phone: dc.phone,
          google_link: dc.google_link,
          created_at: dc.created_at,
          owner: {
            name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || 'N/A',
            email: owner.email || ''
          },
          clients: clientsRes.count || 0,
          dogs: dogsRes.count || 0,
          team_members: teamRes.count || 0,
          messages_30d: msgs30d,
          messages_7d: msgs7d,
          last_message_at: lastMsgAt,
          days_since_last_msg: daysSinceLastMsg,
          days_since_signup: daysSinceSignup,
          is_inactive_14d: isInactive14d,
          is_zero_7d: isZero7d,
          subscription: sub ? { plan: sub.plan, status: sub.status, billing_cycle: sub.billing_cycle || 'monthly' } : null,
          mrr
        };
      })
    );

    // Aggregate totals
    const new30d = daycares.filter(dc => dc.created_at && new Date(dc.created_at) >= new Date(thirtyDaysAgo)).length;
    const inactive14dCount = locationStats.filter(l => l.is_inactive_14d).length;
    const zeroUsage7dCount = locationStats.filter(l => l.is_zero_7d).length;
    const totalMrr = locationStats.reduce((acc, l) => acc + l.mrr, 0);
    const avgTenureDays = locationStats.length
      ? Math.round(locationStats.reduce((acc, l) => acc + l.days_since_signup, 0) / locationStats.length)
      : 0;

    const totals = locationStats.reduce(
      (acc, loc) => ({
        locations: acc.locations + 1,
        new_30d: new30d,
        clients: acc.clients + loc.clients,
        dogs: acc.dogs + loc.dogs,
        messages_30d: acc.messages_30d + loc.messages_30d,
        mrr: totalMrr,
        inactive_14d: inactive14dCount,
        zero_usage_7d: zeroUsage7dCount,
        avg_tenure_days: avgTenureDays
      }),
      { locations: 0, new_30d: 0, clients: 0, dogs: 0, messages_30d: 0, mrr: 0, inactive_14d: 0, zero_usage_7d: 0, avg_tenure_days: 0 }
    );

    // Plan distribution
    const planDist = { starter: 0, growth: 0, partner: 0, none: 0 };
    locationStats.forEach(l => {
      const p = (l.subscription?.plan || '').toLowerCase();
      if (planDist.hasOwnProperty(p)) planDist[p]++;
      else planDist.none++;
    });

    // Status distribution
    const statusDist = { active: 0, past_due: 0, canceled: 0, none: 0 };
    locationStats.forEach(l => {
      const s = (l.subscription?.status || '').toLowerCase();
      if (s === 'active') statusDist.active++;
      else if (s === 'past_due') statusDist.past_due++;
      else if (s === 'canceled') statusDist.canceled++;
      else statusDist.none++;
    });

    // State distribution
    const stateMap = {};
    locationStats.forEach(l => {
      if (l.state) stateMap[l.state] = (stateMap[l.state] || 0) + 1;
    });
    const stateDist = Object.entries(stateMap)
      .map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count);

    console.log('[CEO] totals:', JSON.stringify(totals));

    res.json({
      role: req.userRole,
      totals,
      plan_distribution: planDist,
      status_distribution: statusDist,
      state_distribution: stateDist,
      locations: locationStats
    });
  } catch (err) {
    console.error('CEO overview error:', err);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

// GET /api/ceo/whoami — debug endpoint to check role
router.get('/whoami', requireAuth, async (req, res) => {
  res.json({ userId: req.user?.id, email: req.user?.email, role: req.userRole, daycareId: req.daycareId });
});

// GET /api/ceo/accounts — super_admin only
router.get('/accounts', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, first_name, last_name, phone, is_super_admin, created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const enriched = await Promise.all(profiles.map(async (p) => {
      const { data: daycares } = await supabaseAdmin
        .from('daycares')
        .select('id, name, city, state')
        .eq('owner_id', p.id);
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('plan, status')
        .eq('user_id', p.id)
        .single();
      return { ...p, daycares: daycares || [], subscription: sub || null };
    }));

    res.json({ accounts: enriched });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load accounts' });
  }
});

module.exports = router;
