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
    supabaseAdmin.from('daycares').select('name, city, state').eq('id', req.daycareId).single()
  ]);

  res.json({
    clients: clientsRes.count || 0,
    dogs: dogsRes.count || 0,
    messages_this_month: messagesRes.count || 0,
    daycare: daycareRes.data
  });
});

module.exports = router;
