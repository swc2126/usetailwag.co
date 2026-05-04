const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { sendSms } = require('../utils/telnyx');

// Helper: get the daycare's assigned phone number
async function getDaycareNumber(daycareId) {
  const { data } = await supabaseAdmin
    .from('messaging_config')
    .select('phone_number')
    .eq('daycare_id', daycareId)
    .eq('status', 'active')
    .single();
  return data?.phone_number;
}

// Helper: get daycare info
async function getDaycareInfo(daycareId) {
  const { data } = await supabaseAdmin
    .from('daycares')
    .select('name, owner_id')
    .eq('id', daycareId)
    .single();
  return data;
}

// Helper: send a single reminder SMS
async function sendReminderSms(fromNumber, toPhone, firstName, dogName, daycareName, appointmentDate) {
  const date = new Date(appointmentDate + 'T12:00:00');
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const text = `Hi ${firstName}! Just a reminder that ${dogName} is scheduled at ${daycareName} on ${dayName}. Reply YES to confirm or NO to cancel.`;
  try {
    await sendSms({ from: fromNumber, to: toPhone, text });
    return true;
  } catch (err) {
    console.error('Reminder SMS error:', err.message);
    return false;
  }
}

// Helper: format YYYY-MM-DD → "Mon May 13"
function fmtShortDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// Helper: format an array of names into a natural English list
//   ['Buddy']                   → 'Buddy'
//   ['Buddy', 'Daisy']          → 'Buddy & Daisy'
//   ['Buddy', 'Daisy', 'Max']   → 'Buddy, Daisy, and Max'
function joinNames(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
}

// Helper: send a weekly summary SMS listing all upcoming appointments.
// Adapts the body to the client's dog/schedule structure:
//   - 1 dog                       → "Buddy at TailWag this week: Mon, Wed, Fri."
//   - N dogs sharing the same days → "Buddy & Daisy at TailWag this week: …"
//   - N dogs with different days   → "At TailWag this week:\n• Buddy: …\n• Daisy: …"
async function sendWeeklySummarySms(fromNumber, client, upcoming, daycare) {
  // Group dates by dog name (de-duplicated)
  const byDog = {};
  for (const u of upcoming) {
    const name = u.dogs?.name || '_no_dog';
    if (!byDog[name]) byDog[name] = new Set();
    byDog[name].add(u.appointment_date);
  }
  const realDogs = Object.entries(byDog)
    .filter(([name]) => name !== '_no_dog')
    .map(([name, dates]) => ({ name, dates: [...dates].sort() }));

  let intro;
  if (realDogs.length === 1) {
    const dog = realDogs[0];
    intro = `${dog.name} at ${daycare.name} this week: ${dog.dates.map(fmtShortDate).join(', ')}.`;
  } else if (realDogs.length === 0) {
    const allDates = [...new Set(upcoming.map(u => u.appointment_date))].sort().map(fmtShortDate);
    intro = `Your pup at ${daycare.name} this week: ${allDates.join(', ')}.`;
  } else {
    // Multiple dogs — same schedule or different?
    const firstSig = realDogs[0].dates.join('|');
    const allSame = realDogs.every(d => d.dates.join('|') === firstSig);
    if (allSame) {
      const dates = realDogs[0].dates.map(fmtShortDate).join(', ');
      intro = `${joinNames(realDogs.map(d => d.name))} at ${daycare.name} this week: ${dates}.`;
    } else {
      const lines = realDogs.map(d => `• ${d.name}: ${d.dates.map(fmtShortDate).join(', ')}`).join('\n');
      intro = `At ${daycare.name} this week:\n${lines}`;
    }
  }

  const phoneTail = daycare?.phone ? ` Or call us at ${daycare.phone}.` : '';
  const text =
    `Hi ${client.first_name}! ${intro}\n\n` +
    `Reply YES to confirm all\n` +
    `Reply NO + day (e.g. NO TUE) to skip just that day.${phoneTail}`;

  try {
    await sendSms({ from: fromNumber, to: client.phone, text });
    return true;
  } catch (err) {
    console.error('Weekly summary SMS error:', err.message);
    return false;
  }
}

// ─── REUSABLE: stamp the daycare with the last reminder run ───────────────
async function recordReminderRun(daycareId, trigger, perVisit, weekly) {
  const summary = {
    trigger,
    per_visit: {
      sent:    perVisit?.sent    || 0,
      failed:  perVisit?.failed  || 0,
      skipped: perVisit?.skipped || 0
    },
    weekly: {
      sent:    weekly?.sent    || 0,
      failed:  weekly?.failed  || 0,
      skipped: weekly?.skipped || 0
    }
  };
  try {
    await supabaseAdmin.from('daycares')
      .update({
        last_reminder_run_at: new Date().toISOString(),
        last_reminder_run_summary: summary
      })
      .eq('id', daycareId);
  } catch (err) {
    // Don't let logging failure break the reminder send
    console.error('recordReminderRun error:', err.message);
  }
}

// ─── REUSABLE: per-visit reminders for one daycare/date ──────────────────
// Used by both POST /send-reminders and the daily cron.
async function runDailyReminders(daycareId, date) {
  const fromNumber = await getDaycareNumber(daycareId);
  if (!fromNumber) return { sent: 0, failed: 0, skipped: 0, reason: 'no_number' };
  const daycare = await getDaycareInfo(daycareId);

  const { data: appts, error } = await supabaseAdmin
    .from('appointments')
    .select('id, client_id, dog_id, status, clients(first_name, phone, reminder_cadence), dogs(name)')
    .eq('daycare_id', daycareId)
    .eq('appointment_date', date)
    .eq('status', 'pending')
    .is('reminder_sent_at', null);

  if (error) return { sent: 0, failed: 0, skipped: 0, error: error.message };
  if (!appts.length) return { sent: 0, failed: 0, skipped: 0 };

  let sent = 0, failed = 0, skipped = 0;
  for (const appt of appts) {
    if (!appt.clients?.phone) { failed++; continue; }
    const cadence = appt.clients?.reminder_cadence || 'per_visit';
    if (cadence !== 'per_visit') { skipped++; continue; }

    const dogName = appt.dogs?.name || 'your pup';
    const ok = await sendReminderSms(fromNumber, appt.clients.phone, appt.clients.first_name, dogName, daycare.name, date);
    if (ok) {
      await supabaseAdmin.from('appointments').update({ reminder_sent_at: new Date().toISOString() }).eq('id', appt.id);
      sent++;
    } else {
      failed++;
    }
  }
  return { sent, failed, skipped };
}

// ─── REUSABLE: weekly summaries for one daycare ──────────────────────────
// 7-day rate-limit window (was 6) so a client never receives two summaries
// inside a 7-day stretch even if a manual trigger fires off-schedule.
async function runWeeklySummaries(daycareId) {
  const fromNumber = await getDaycareNumber(daycareId);
  if (!fromNumber) return { sent: 0, failed: 0, skipped: 0, reason: 'no_number' };
  const daycare = await getDaycareInfo(daycareId);

  const todayStr = new Date().toISOString().split('T')[0];
  const sevenDays = new Date(Date.now() + 7 * 86400_000).toISOString().split('T')[0];
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();

  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, first_name, phone, last_summary_sent_at')
    .eq('daycare_id', daycareId)
    .eq('active', true)
    .eq('reminder_cadence', 'weekly_summary');

  if (!clients?.length) return { sent: 0, failed: 0, skipped: 0 };

  let sent = 0, failed = 0, skipped = 0;
  for (const c of clients) {
    if (!c.phone) { skipped++; continue; }
    if (c.last_summary_sent_at && c.last_summary_sent_at > sevenDaysAgo) { skipped++; continue; }

    const { data: upcoming } = await supabaseAdmin
      .from('appointments')
      .select('id, appointment_date, dogs(name)')
      .eq('daycare_id', daycareId)
      .eq('client_id', c.id)
      .eq('status', 'pending')
      .gte('appointment_date', todayStr)
      .lte('appointment_date', sevenDays)
      .order('appointment_date', { ascending: true });

    if (!upcoming?.length) { skipped++; continue; }

    const ok = await sendWeeklySummarySms(fromNumber, c, upcoming, daycare);
    if (ok) {
      const apptIds = upcoming.map(u => u.id).filter(Boolean);
      const now = new Date().toISOString();
      if (apptIds.length) {
        await supabaseAdmin.from('appointments').update({ reminder_sent_at: now }).in('id', apptIds);
      }
      await supabaseAdmin.from('clients').update({ last_summary_sent_at: now }).eq('id', c.id);
      sent++;
    } else {
      failed++;
    }
  }
  return { sent, failed, skipped };
}

// ─── APPOINTMENTS ────────────────────────────────────────────────────────────

// GET /api/appointments/range?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns all appointments grouped by date for week/month views
router.get('/range', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end required' });

  const { data: appts, error } = await supabaseAdmin
    .from('appointments')
    .select('id, appointment_date, status, client_id, dog_id, notes, reminder_sent_at, clients(first_name, last_name), dogs(name, breed)')
    .eq('daycare_id', req.daycareId)
    .gte('appointment_date', start)
    .lte('appointment_date', end);

  if (error) return res.status(500).json({ error: error.message });

  const { data: recurring } = await supabaseAdmin
    .from('recurring_schedules')
    .select('client_id, dog_id, days_of_week, clients(first_name, last_name), dogs(name)')
    .eq('daycare_id', req.daycareId)
    .eq('active', true);

  // Group explicit appointments by date
  const grouped = {};
  (appts || []).forEach(a => {
    if (!grouped[a.appointment_date]) grouped[a.appointment_date] = [];
    grouped[a.appointment_date].push(a);
  });

  // Merge recurring for each date in range
  const startD = new Date(start + 'T12:00:00');
  const endD   = new Date(end   + 'T12:00:00');
  for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const dow     = d.getDay();
    const matches = (recurring || []).filter(r => r.days_of_week.includes(dow));
    if (matches.length) {
      if (!grouped[dateStr]) grouped[dateStr] = [];
      const existing = new Set(grouped[dateStr].map(a => `${a.client_id}-${a.dog_id}`));
      matches.forEach(r => {
        if (!existing.has(`${r.client_id}-${r.dog_id}`)) {
          grouped[dateStr].push({
            id: null, appointment_date: dateStr, status: 'recurring_pending',
            client_id: r.client_id, dog_id: r.dog_id,
            clients: r.clients, dogs: r.dogs, is_recurring: true
          });
        }
      });
    }
  }

  res.json(grouped);
});

// GET /api/appointments/by-client/:clientId — all appointments for one client
router.get('/by-client/:clientId', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { clientId } = req.params;
  const { data, error } = await supabaseAdmin
    .from('appointments')
    .select('id, appointment_date, status, notes, dogs(id, name, breed)')
    .eq('daycare_id', req.daycareId)
    .eq('client_id', clientId)
    .order('appointment_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /api/appointments?date=YYYY-MM-DD
// Returns appointments for a date, merging in recurring schedules
router.get('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const date = req.query.date || new Date(Date.now() + 86400000).toISOString().split('T')[0]; // default tomorrow

  // 1. Explicit appointments for this date
  const { data: explicit, error: e1 } = await supabaseAdmin
    .from('appointments')
    .select('id, client_id, dog_id, status, reminder_sent_at, confirmed_at, notes, clients(first_name, last_name, phone), dogs(name, breed)')
    .eq('daycare_id', req.daycareId)
    .eq('appointment_date', date);

  if (e1) return res.status(500).json({ error: e1.message });

  // 2. Recurring schedules that match this day of week
  const dow = new Date(date + 'T12:00:00').getDay(); // 0=Sun ... 6=Sat
  const { data: recurring } = await supabaseAdmin
    .from('recurring_schedules')
    .select('id, client_id, dog_id, days_of_week, clients(first_name, last_name, phone), dogs(name, breed)')
    .eq('daycare_id', req.daycareId)
    .eq('active', true)
    .contains('days_of_week', [dow]);

  // Merge: recurring dogs not already in explicit list become pending
  const explicitPairs = new Set(explicit.map(a => `${a.client_id}-${a.dog_id}`));
  const recurringToAdd = (recurring || []).filter(r => !explicitPairs.has(`${r.client_id}-${r.dog_id}`));

  const merged = [
    ...explicit,
    ...recurringToAdd.map(r => ({
      id: null,
      client_id: r.client_id,
      dog_id: r.dog_id,
      status: 'recurring_pending',
      reminder_sent_at: null,
      confirmed_at: null,
      notes: null,
      recurring_schedule_id: r.id,
      clients: r.clients,
      dogs: r.dogs,
      is_recurring: true
    }))
  ];

  res.json({ date, day_of_week: dow, appointments: merged });
});

// POST /api/appointments — add a dog to a specific date
router.post('/', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { client_id, dog_id, appointment_date, notes } = req.body;
  if (!client_id || !appointment_date) return res.status(400).json({ error: 'client_id and appointment_date required' });

  // Upsert — avoid duplicates
  const { data, error } = await supabaseAdmin
    .from('appointments')
    .upsert({
      daycare_id: req.daycareId,
      client_id,
      dog_id: dog_id || null,
      appointment_date,
      notes: notes || null,
      status: 'pending',
      created_by: req.user.id
    }, { onConflict: 'daycare_id,client_id,dog_id,appointment_date', ignoreDuplicates: false })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// DELETE /api/appointments/:id — remove from schedule
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('appointments')
    .delete()
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PATCH /api/appointments/:id/status — manually update status
router.patch('/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'confirmed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const { data, error } = await supabaseAdmin
    .from('appointments')
    .update({ status, confirmed_at: status === 'confirmed' ? new Date().toISOString() : null })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/appointments/send-reminders — send reminders for a given date
router.post('/send-reminders', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

  const result = await runDailyReminders(req.daycareId, date);
  if (result.reason === 'no_number') return res.status(400).json({ error: 'No phone number assigned.' });
  if (result.error) return res.status(500).json({ error: result.error });
  await recordReminderRun(req.daycareId, 'manual', result, null);
  return res.json({ success: true, ...result, message: result.sent === 0 ? 'No pending appointments to remind.' : undefined });
});

// POST /api/appointments/send-weekly-summaries — send one summary per
// client whose reminder_cadence is 'weekly_summary' and who has at
// least one pending appointment in the next 7 days. Skips clients
// already summarized in the last 7 days.
router.post('/send-weekly-summaries', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const result = await runWeeklySummaries(req.daycareId);
  if (result.reason === 'no_number') return res.status(400).json({ error: 'No phone number assigned.' });
  await recordReminderRun(req.daycareId, 'manual', null, result);
  return res.json({ success: true, ...result });
});

// POST /api/appointments/run-reminders — combined entry point that
// fires per-visit reminders for the given date AND weekly summaries
// for clients due, then records ONE log entry on the daycare row.
// The schedule page's "Send Reminders" button uses this so the caption
// shows the merged count instead of a stale partial one.
router.post('/run-reminders', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

  const [perVisit, weekly] = await Promise.all([
    runDailyReminders(req.daycareId, date),
    runWeeklySummaries(req.daycareId)
  ]);
  if (perVisit.reason === 'no_number' && weekly.reason === 'no_number') {
    return res.status(400).json({ error: 'No phone number assigned.' });
  }
  await recordReminderRun(req.daycareId, 'manual', perVisit, weekly);
  return res.json({
    success: true,
    per_visit: perVisit,
    weekly,
    last_reminder_run_at: new Date().toISOString()
  });
});

// POST /api/appointments/morning-summary — send morning confirmation summary to site manager
router.post('/morning-summary', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { date, manager_phone } = req.body;
  if (!date || !manager_phone) return res.status(400).json({ error: 'date and manager_phone required' });

  const fromNumber = await getDaycareNumber(req.daycareId);
  const daycare = await getDaycareInfo(req.daycareId);
  if (!fromNumber) return res.status(400).json({ error: 'No phone number assigned.' });

  const { data: appts } = await supabaseAdmin
    .from('appointments')
    .select('status')
    .eq('daycare_id', req.daycareId)
    .eq('appointment_date', date);

  const counts = { confirmed: 0, pending: 0, cancelled: 0 };
  (appts || []).forEach(a => { if (counts[a.status] !== undefined) counts[a.status]++; });
  const total = counts.confirmed + counts.pending + counts.cancelled;

  const date2 = new Date(date + 'T12:00:00');
  const dayName = date2.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const summary = `${daycare.name} — ${dayName} schedule: ${total} total · ${counts.confirmed} confirmed ✓ · ${counts.pending} no reply · ${counts.cancelled} cancelled. Have a great day!`;

  try {
    await sendSms({ from: fromNumber, to: manager_phone, text: summary });
    res.json({ success: true, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RECURRING SCHEDULES ─────────────────────────────────────────────────────

// GET /api/appointments/recurring
router.get('/recurring', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { data, error } = await supabaseAdmin
    .from('recurring_schedules')
    .select('id, client_id, dog_id, days_of_week, active, clients(first_name, last_name, phone), dogs(name, breed)')
    .eq('daycare_id', req.daycareId)
    .eq('active', true)
    .order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/appointments/recurring
router.post('/recurring', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { client_id, dog_id, days_of_week } = req.body;
  if (!client_id || !days_of_week?.length) return res.status(400).json({ error: 'client_id and days_of_week required' });

  const { data, error } = await supabaseAdmin
    .from('recurring_schedules')
    .upsert({
      daycare_id: req.daycareId,
      client_id,
      dog_id: dog_id || null,
      days_of_week,
      active: true
    }, { onConflict: 'daycare_id,client_id,dog_id', ignoreDuplicates: false })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/appointments/recurring/:id — update days_of_week and/or dog_id
router.patch('/recurring/:id', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { days_of_week, dog_id } = req.body;
  const updates = {};
  if (Array.isArray(days_of_week)) {
    if (!days_of_week.length) return res.status(400).json({ error: 'days_of_week cannot be empty' });
    if (days_of_week.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
      return res.status(400).json({ error: 'days_of_week must be integers 0–6' });
    }
    updates.days_of_week = [...new Set(days_of_week)].sort((a,b) => a - b);
  }
  if (dog_id !== undefined) updates.dog_id = dog_id || null;
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

  const { data, error } = await supabaseAdmin
    .from('recurring_schedules')
    .update(updates)
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/appointments/recurring/:id
router.delete('/recurring/:id', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('recurring_schedules')
    .update({ active: false })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /api/appointments/recurring/:id/restore — undo soft-delete
router.post('/recurring/:id/restore', requireAuth, async (req, res) => {
  const { error } = await supabaseAdmin
    .from('recurring_schedules')
    .update({ active: true })
    .eq('id', req.params.id)
    .eq('daycare_id', req.daycareId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Inbound SMS handling lives in routes/sms.js (POST /api/sms/telnyx/inbound)

module.exports = router;
module.exports.runDailyReminders = runDailyReminders;
module.exports.runWeeklySummaries = runWeeklySummaries;
module.exports.recordReminderRun = recordReminderRun;
