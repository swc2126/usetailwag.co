// middleware/auth.js
const { supabaseAdmin } = require('../config/supabase');

// Map legacy DB role values to new role names
const ROLE_MAP = {
  super_admin:  'super_admin',
  owner:        'owner',
  manager:      'manager',
  admin:        'manager',     // legacy → manager
  team_member:  'team_member',
  staff:        'team_member'  // legacy → team_member
};

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

    // 1. Check super_admin first
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('is_super_admin')
      .eq('id', user.id)
      .single();

    if (profile?.is_super_admin) {
      req.userRole = 'super_admin';
      req.daycareId = null; // super_admin not scoped to one daycare
      return next();
    }

    // 2. Check team_members for daycare assignment
    const { data: member } = await supabaseAdmin
      .from('team_members')
      .select('daycare_id, role')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .single();

    if (member) {
      req.daycareId = member.daycare_id;
      req.userRole = ROLE_MAP[member.role] || 'team_member';
      return next();
    }

    // 3. Fallback: check daycares table for owner
    const { data: daycare } = await supabaseAdmin
      .from('daycares')
      .select('id')
      .eq('owner_id', user.id)
      .single();

    if (daycare) {
      req.daycareId = daycare.id;
      req.userRole = 'owner';
      return next();
    }

    // Authenticated but no role/daycare assigned yet
    req.userRole = null;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Authentication failed' });
  }
}

// Role hierarchy for permission checks
const ROLE_HIERARCHY = ['team_member', 'manager', 'owner', 'super_admin'];

// Middleware: require one of the specified roles
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Middleware: require at least a minimum role level
function requireMinRole(minRole) {
  return (req, res, next) => {
    const userLevel = ROLE_HIERARCHY.indexOf(req.userRole);
    const minLevel  = ROLE_HIERARCHY.indexOf(minRole);
    if (userLevel < minLevel) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Helper: check if user can access a specific daycare
function canAccessDaycare(req, daycareId) {
  if (req.userRole === 'super_admin') return true;
  return req.daycareId === daycareId;
}

module.exports = { requireAuth, requireRole, requireMinRole, canAccessDaycare };
