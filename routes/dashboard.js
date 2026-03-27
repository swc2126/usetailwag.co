const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

router.get('/stats', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const [clientsRes, dogsRes, messagesRes, daycareRes] = await Promise.all([
    supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).eq('active', true),
    supabaseAdmin.from('dogs').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).eq('active', true),
    supabaseAdmin.from('messages').select('id', { count: 'exact', head: true }).eq('daycare_id', req.daycareId).gte('created_at', start.toISOString()),
    supabaseAdmin.from('daycares').select('name, city, state, google_link').eq('id', req.daycareId).single()
  ]);

  res.json({
    clients: clientsRes.count || 0,
    dogs: dogsRes.count || 0,
    messages_this_month: messagesRes.count || 0,
    daycare: daycareRes.data
  });
});

// PUT /api/dashboard/daycare — update daycare settings
router.put('/daycare', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  if (!['owner', 'admin'].includes(req.userRole)) return res.status(403).json({ error: 'Insufficient permissions' });

  const { google_link } = req.body;

  // Validate URL if provided
  if (google_link) {
    try { new URL(google_link); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  }

  const { data, error } = await supabaseAdmin
    .from('daycares')
    .update({ google_link: google_link || null })
    .eq('id', req.daycareId)
    .select('name, city, state, google_link')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
