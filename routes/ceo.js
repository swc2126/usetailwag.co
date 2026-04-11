const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET /api/ceo/overview
// super_admin → all daycares on the platform
// owner       → daycares they own
// manager     → daycares they are assigned to
router.get('/overview', requireAuth, requireRole('super_admin', 'owner', 'manager'), async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    let daycares, dcError;

    if (req.userRole === 'super_admin') {
      // All daycares on the platform with owner info
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, city, state, phone, google_link, owner_id, profiles(first_name, last_name, email)')
        .order('name'));
    } else if (req.userRole === 'owner') {
      // Daycares this user owns
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, city, state, phone, google_link, owner_id')
        .eq('owner_id', req.user.id)
        .order('name'));
    } else if (req.userRole === 'manager') {
      // Daycares this manager is assigned to
      const { data: assignments } = await supabaseAdmin
        .from('team_members')
        .select('daycare_id')
        .eq('user_id', req.user.id)
        .eq('status', 'active');
      const ids = (assignments || []).map(a => a.daycare_id);
      if (!ids.length) return res.json({ locations: [], totals: { locations: 0, clients: 0, dogs: 0, messages_this_month: 0 } });
      ({ data: daycares, error: dcError } = await supabaseAdmin
        .from('daycares')
        .select('id, name, city, state, phone, google_link, owner_id')
        .in('id', ids)
        .order('name'));
    }

    if (dcError) return res.status(500).json({ error: dcError.message });
    if (!daycares || !daycares.length) {
      return res.json({ locations: [], totals: { locations: 0, clients: 0, dogs: 0, messages_this_month: 0 } });
    }

    // Fetch stats per daycare in parallel
    const locationStats = await Promise.all(
      daycares.map(async (dc) => {
        const [clientsRes, dogsRes, messagesRes, teamRes, subRes] = await Promise.all([
          supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('active', true),
          supabaseAdmin.from('dogs').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('active', true),
          supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).gte('created_at', startOfMonth.toISOString()),
          supabaseAdmin.from('team_members').select('id', { count: 'exact', head: true }).eq('daycare_id', dc.id).eq('status', 'active'),
          supabaseAdmin.from('subscriptions').select('status, plan').eq('daycare_id', dc.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
        ]);

        const result = {
          id: dc.id,
          name: dc.name,
          city: dc.city,
          state: dc.state,
          phone: dc.phone,
          google_link: dc.google_link,
          clients: clientsRes.count || 0,
          dogs: dogsRes.count || 0,
          messages_this_month: messagesRes.count || 0,
          team_members: teamRes.count || 0,
          subscription: subRes.data || null
        };

        // Super admin also sees owner info
        if (req.userRole === 'super_admin' && dc.profiles) {
          result.owner = {
            name: [dc.profiles.first_name, dc.profiles.last_name].filter(Boolean).join(' ') || 'N/A',
            email: dc.profiles.email || ''
          };
        }

        return result;
      })
    );

    const totals = locationStats.reduce(
      (acc, loc) => ({
        locations: acc.locations + 1,
        clients: acc.clients + loc.clients,
        dogs: acc.dogs + loc.dogs,
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

// GET /api/ceo/accounts — super_admin only: all accounts with full detail
router.get('/accounts', requireAuth, requireRole('super_admin'), async (req, res) => {
  try {
    const { data: profiles, error } = await supabaseAdmin
      .from('profiles')
      .select('id, email, first_name, last_name, phone, is_super_admin, created_at')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    // Get daycares for each profile
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
