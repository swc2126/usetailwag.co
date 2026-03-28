const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// GET /api/reviews/stats — review request stats for this month
router.get('/stats', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('id, status, created_at')
    .eq('daycare_id', req.daycareId)
    .gte('created_at', start.toISOString())
    .or('body.ilike.%g.page%,body.ilike.%google.com/maps%,body.ilike.%maps.google%');

  if (error) return res.status(500).json({ error: error.message });

  res.json({
    total: data.length,
    delivered: data.filter(m => m.status === 'delivered').length,
    sent: data.filter(m => m.status === 'sent').length,
    failed: data.filter(m => m.status === 'failed').length
  });
});

// GET /api/reviews/history — review request message history
router.get('/history', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('*, clients(first_name, last_name)')
    .eq('daycare_id', req.daycareId)
    .or('body.ilike.%g.page%,body.ilike.%google.com/maps%,body.ilike.%maps.google%')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/reviews/client/:clientId/requested
// Called automatically when a review request SMS is sent — stamps review_requested_at
router.patch('/client/:clientId/requested', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({ review_requested_at: new Date().toISOString() })
    .eq('id', req.params.clientId)
    .eq('daycare_id', req.daycareId)
    .select('id, review_requested_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/reviews/client/:clientId/received
// Called manually by staff when they confirm a review came in — stamps review_received_at
router.patch('/client/:clientId/received', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({ review_received_at: new Date().toISOString() })
    .eq('id', req.params.clientId)
    .eq('daycare_id', req.daycareId)
    .select('id, review_received_at')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/reviews/client/:clientId/received
// Clears review_received_at if marked by mistake
router.delete('/client/:clientId/received', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({ review_received_at: null })
    .eq('id', req.params.clientId)
    .eq('daycare_id', req.daycareId)
    .select('id')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
