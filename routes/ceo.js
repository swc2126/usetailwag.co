const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /api/ceo/overview
// Returns all daycares owned by the authenticated user, with per-location stats
// and rolled-up totals. The user must be the owner_id on each daycare record.
router.get('/overview', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Find all daycares owned by this user
    const { data: daycares, error: dcError } = await supabaseAdmin
      .from('daycares')
      .select('id, name, city, state, phone, google_link')
      .eq('owner_id', userId)
      .order('name');

    if (dcError) return res.status(500).json({ error: dcError.message });
    if (!daycares || daycares.length === 0) {
      return res.json({ locations: [], totals: { locations: 0, clients: 0, dogs: 0, messages_this_month: 0 } });
    }

    // 2. For each daycare, fetch stats in parallel
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const locationStats = await Promise.all(
      daycares.map(async (dc) => {
        const [clientsRes, dogsRes, messagesRes, teamRes, subRes] = await Promise.all([
          supabaseAdmin
            .from('clients')
            .select('id', { count: 'exact', head: true })
            .eq('daycare_id', dc.id)
            .eq('active', true),
          supabaseAdmin
            .from('dogs')
            .select('id', { count: 'exact', head: true })
            .eq('daycare_id', dc.id)
            .eq('active', true),
          supabaseAdmin
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('daycare_id', dc.id)
            .gte('created_at', startOfMonth.toISOString()),
          supabaseAdmin
            .from('team_members')
            .select('id', { count: 'exact', head: true })
            .eq('daycare_id', dc.id)
            .eq('status', 'active'),
          supabaseAdmin
            .from('subscriptions')
            .select('status, plan')
            .eq('daycare_id', dc.id)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
        ]);

        return {
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
      })
    );

    // 3. Roll up totals
    const totals = locationStats.reduce(
      (acc, loc) => ({
        locations: acc.locations + 1,
        clients: acc.clients + loc.clients,
        dogs: acc.dogs + loc.dogs,
        messages_this_month: acc.messages_this_month + loc.messages_this_month
      }),
      { locations: 0, clients: 0, dogs: 0, messages_this_month: 0 }
    );

    res.json({ locations: locationStats, totals });
  } catch (err) {
    console.error('CEO overview error:', err);
    res.status(500).json({ error: 'Failed to load CEO overview' });
  }
});

module.exports = router;
