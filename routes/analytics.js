const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /api/analytics/overview
// Works for all roles: team_member, manager, owner, super_admin
// Query param: ?daycareId=xxx (owners with multiple locations)
router.get('/overview', requireAuth, async (req, res) => {
  try {
    console.log('[Analytics] overview hit — userId:', req.user?.id, 'role:', req.userRole);

    // Step 1: Resolve daycareId
    let daycareId;
    if (req.userRole === 'team_member' || req.userRole === 'manager') {
      daycareId = req.daycareId;
    } else if (req.userRole === 'owner') {
      daycareId = req.query.daycareId || req.daycareId;
    } else if (req.userRole === 'super_admin') {
      daycareId = req.query.daycareId;
    }

    if (!daycareId) {
      return res.status(400).json({ error: 'No daycareId resolved. Please specify ?daycareId=xxx' });
    }

    // Step 2: Validate access
    if (req.userRole === 'super_admin') {
      // super_admin can access any daycare — no additional check needed
    } else if (req.userRole === 'owner') {
      const { data: dc } = await supabaseAdmin
        .from('daycares')
        .select('owner_id')
        .eq('id', daycareId)
        .single();
      if (!dc || dc.owner_id !== req.user.id) {
        return res.status(403).json({ error: 'You do not own this daycare' });
      }
    } else {
      // manager or team_member
      if (req.daycareId !== daycareId) {
        return res.status(403).json({ error: 'Access denied to this daycare' });
      }
    }

    // Step 3: Compute time boundaries
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekAgo = new Date(now - 7 * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    const sixtyDaysAgo = new Date(now - 60 * 86400000);

    // Step 4: Personal stats (in parallel)
    const [todayRes, weekRes, monthRes, streakRes] = await Promise.all([
      supabaseAdmin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_id', req.user.id)
        .eq('daycare_id', daycareId)
        .gte('created_at', todayStart.toISOString()),
      supabaseAdmin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_id', req.user.id)
        .eq('daycare_id', daycareId)
        .gte('created_at', weekAgo.toISOString()),
      supabaseAdmin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('sender_id', req.user.id)
        .eq('daycare_id', daycareId)
        .gte('created_at', monthStart.toISOString()),
      supabaseAdmin
        .from('messages')
        .select('created_at')
        .eq('sender_id', req.user.id)
        .eq('daycare_id', daycareId)
        .gte('created_at', sixtyDaysAgo.toISOString())
        .order('created_at', { ascending: false })
    ]);

    const todayCount = todayRes.count || 0;
    const weekCount = weekRes.count || 0;
    const monthCount = monthRes.count || 0;

    // Streak calculation
    const streakRows = streakRes.data || [];
    const dates = [...new Set(streakRows.map(m => m.created_at.slice(0, 10)))].sort((a, b) => b.localeCompare(a));
    const todayStr = now.toISOString().slice(0, 10);
    const yesterdayStr = new Date(now - 86400000).toISOString().slice(0, 10);
    let streak = 0;
    let expected = dates[0] === todayStr ? todayStr : (dates[0] === yesterdayStr ? yesterdayStr : null);
    if (expected) {
      for (const d of dates) {
        if (d === expected) {
          streak++;
          const prev = new Date(expected + 'T12:00:00Z');
          prev.setDate(prev.getDate() - 1);
          expected = prev.toISOString().slice(0, 10);
        } else if (d < expected) break;
      }
    }

    // Step 5: Fetch all messages for this daycare last 30 days
    const { data: msgs30 } = await supabaseAdmin
      .from('messages')
      .select('id, sender_id, client_id, message_type, created_at, is_bulk')
      .eq('daycare_id', daycareId)
      .gte('created_at', thirtyDaysAgo.toISOString());
    const msgs30arr = msgs30 || [];

    // Derived location message stats
    const msgsTodayLocation = msgs30arr.filter(m => new Date(m.created_at) >= todayStart).length;
    const msgsWeekLocation = msgs30arr.filter(m => new Date(m.created_at) >= weekAgo).length;

    // Message type counts
    const msg_type_counts = { report_card: 0, bulk: 0, review_request: 0, reminder: 0, custom: 0 };
    for (const msg of msgs30arr) {
      const t = msg.message_type || (msg.is_bulk ? 'bulk' : 'custom');
      if (msg_type_counts.hasOwnProperty(t)) {
        msg_type_counts[t]++;
      } else {
        msg_type_counts.custom++;
      }
    }

    // Personal week pct of team volume
    const msgs_week_personal = msgs30arr.filter(m => new Date(m.created_at) >= weekAgo && m.sender_id === req.user.id).length;
    const userTeamPct = msgsWeekLocation > 0 ? Math.round((msgs_week_personal / msgsWeekLocation) * 100) : 0;

    // Step 6: Fetch location data
    const [clientsRes, dogsRes, newClientsRes, daycareRes] = await Promise.all([
      supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', daycareId).eq('active', true),
      supabaseAdmin.from('dogs').select('id', { count: 'exact', head: true }).eq('daycare_id', daycareId).eq('active', true),
      supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', daycareId).eq('active', true).gte('created_at', thirtyDaysAgo.toISOString()),
      supabaseAdmin.from('daycares').select('id, name, city, state, street, google_link, owner_id').eq('id', daycareId).single()
    ]);

    // Step 7: Inactive clients (active with no message in 30d)
    const { data: allClientIds } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('daycare_id', daycareId)
      .eq('active', true);
    const recentClientSet = new Set(msgs30arr.filter(m => m.client_id).map(m => m.client_id));
    const inactive_clients_30d = (allClientIds || []).filter(c => !recentClientSet.has(c.id)).length;

    // Step 8: Team performance (compute always — cheap since msgs30arr already fetched)
    const { data: teamMembers } = await supabaseAdmin
      .from('team_members')
      .select('user_id, role')
      .eq('daycare_id', daycareId)
      .eq('status', 'active');

    const teamUserIds = (teamMembers || []).map(t => t.user_id);

    const { data: teamProfiles } = teamUserIds.length
      ? await supabaseAdmin.from('profiles').select('id, first_name, last_name').in('id', teamUserIds)
      : { data: [] };

    const profileMap = Object.fromEntries((teamProfiles || []).map(p => [p.id, p]));

    const memberStats = {};
    for (const msg of msgs30arr) {
      const sid = msg.sender_id;
      if (!memberStats[sid]) memberStats[sid] = { msgs_month: 0, msgs_week: 0 };
      memberStats[sid].msgs_month++;
      if (new Date(msg.created_at) >= weekAgo) memberStats[sid].msgs_week++;
    }

    const team = (teamMembers || []).map(t => {
      const p = profileMap[t.user_id] || {};
      const s = memberStats[t.user_id] || { msgs_month: 0, msgs_week: 0 };
      return {
        user_id: t.user_id,
        name: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown',
        role: t.role,
        msgs_week: s.msgs_week,
        msgs_month: s.msgs_month
      };
    }).sort((a, b) => b.msgs_month - a.msgs_month);

    // Step 9: Owner data (owner+ only)
    let financial = null;
    let all_locations = [];

    if (['owner', 'super_admin'].includes(req.userRole)) {
      const ownerId = daycareRes.data?.owner_id || req.user.id;
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('plan, status, billing_cycle')
        .eq('user_id', ownerId)
        .single();

      const PLAN_PRICES = { starter: 99, growth: 179, partner: 249 };
      const planKey = (sub?.plan || '').toLowerCase();
      financial = sub ? {
        plan: sub.plan,
        status: sub.status,
        billing_cycle: sub.billing_cycle,
        monthly_cost: PLAN_PRICES[planKey] || 0
      } : null;

      const { data: allDaycares } = await supabaseAdmin
        .from('daycares')
        .select('id, name, city, state')
        .eq('owner_id', ownerId);
      all_locations = allDaycares || [];
    }

    // Step 10: Build and return response
    res.json({
      role: req.userRole,
      daycare: daycareRes.data,
      personal: {
        msgs_today: todayCount,
        msgs_week: weekCount,
        msgs_month: monthCount,
        streak,
        team_volume_pct: userTeamPct
      },
      location: {
        clients: clientsRes.count || 0,
        dogs: dogsRes.count || 0,
        new_clients_30d: newClientsRes.count || 0,
        inactive_clients_30d,
        team_members: teamMembers?.length || 0,
        msgs_today: msgsTodayLocation,
        msgs_week: msgsWeekLocation,
        msgs_30d: msgs30arr.length,
        msg_type_counts,
        team
      },
      financial,
      all_locations
    });
  } catch (err) {
    console.error('[Analytics] overview error:', err);
    res.status(500).json({ error: 'Failed to load analytics overview' });
  }
});

module.exports = router;
