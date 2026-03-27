// middleware/auth.js
const { supabaseAdmin } = require('../config/supabase');

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token' });

    req.user = user;

    // Get daycare association
    const { data: member } = await supabaseAdmin
      .from('team_members')
      .select('daycare_id, role')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single();

    if (member) {
      req.daycareId = member.daycare_id;
      req.userRole = member.role;
    } else {
      // Fallback: check daycares table for owner
      const { data: daycare } = await supabaseAdmin
        .from('daycares')
        .select('id')
        .eq('owner_id', user.id)
        .single();
      if (daycare) {
        req.daycareId = daycare.id;
        req.userRole = 'owner';
      }
    }

    next();
  } catch (err) {
    res.status(401).json({ error: 'Authentication failed' });
  }
}

module.exports = { requireAuth };
