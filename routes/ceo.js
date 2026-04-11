const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /api/ceo/overview
router.get('/overview', requireAuth, requireRole('super_admin', 'owner', 'manager'), async (req, res) => {
  try {
    console.log('[CEO] overview hit — userId:', req.user?.id, 'role:', req.userRole);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    let daycares, dcError;

    if (req.userRole === 'super_admin') {
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, address, phone, google_link, owner_id')
        .order('name'));
    } else if (req.userRole === 'owner') {
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, address, phone, google_link, owner_id')
        .eq('owner_id', req.user.id)
        .order('name'));
    } else if (req.userRole === 'manager') {
      const { data: assignments } = await supabaseAdmin
        .from('team_members')
        .select('daycare_id')
        .eq('user_id', req.user.id)
        .eq('status', 'active');
      const ids = (assignments || []).map(a => a.daycare_id);
      if (!ids.length) return res.json({ locations: [], totals: { locations: 0, clients: 0, dogs: 0, messages_this_month: 0 } });
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, address, phone, google_link, owner_id')
        .in('id', ids)
        .order('name'));
    }

    console.log('[CEO] daycares found:', daycares?.length ?? 0, '| error:', dcError?.message ?? null);
    if (dcError) {
      console.error('CEO daycares query error:', dcError.message);
      return res.status(500).json({ error: dcError.message });
    }
    if (!daycares || !daycares.length) {
      return res.json({ locations: [], totals: { locations: 0, clients: 0, dogs: 0, messages_this_month: 0 } });
    }

    // Collect all unique owner_ids to fetch profiles in one query
    const ownerIds = [...new Set(daycares.map(dc => dc.owner_id).filter(Boolean))];
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, first_name, last_name, email')
      .in('id', ownerIds);
    const profileMap = {};
    (profiles || []).forEach(p => { profileMap[p.id] = p; });

    // Fetch subscriptions by user_id (owner) in one query
    const { data: allSubs } = await supabaseAdmin
      .from('subscriptions')
      .select('user_id, status, plan')
      .in('user_id', ownerIds);
    const subMap = {};
    (allSubs || []).forEach(s => { subMap[s.user_id] = s; });

    // Fetch stats per daycare in parallel
    const locationStats = await Promise.all(
      daycares.map(async (dc) => {
        const [clientsRes, dogsRes, messagesRes, teamRes] = await Promise.all([
          supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('active', true),
          supabaseAdmin.from('dogs').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('active', true),
          supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).gte('created_at', startOfMonth.toISOString()),
          supabaseAdmin.from('team_members').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('status', 'active')
        ]);

        const owner = profileMap[dc.owner_id] || {};
        const sub   = subMap[dc.owner_id] || null;

        return {
          id: dc.id,
          name: dc.name,
          address: dc.address,
          phone: dc.phone,
          google_link: dc.google_link,
          owner: {
            name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || 'N/A',
            email: owner.email || ''
          },
          clients: clientsRes.count || 0,
          dogs: dogsRes.count || 0,
          messages_this_month: messagesRes.count || 0,
          team_members: teamRes.count || 0,
          subscription: sub
        };
      })
    );

    const totals = locationStats.reduce(
      (acc, loc) => ({
        locations: acc.locations + 1,
        clients:   acc.clients   + loc.clients,
        dogs:      acc.dogs      + loc.dogs,
        messages_this_month: acc.messages_this_month + loc.messages_this_month
      }),
      { locations: 0, clients: 0, dogs: 0, messages_this_month: 0 }
    );

    res.json({ locations: locationStats, totals, role: req.userRole });
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
