const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Helper: get Twilio number for daycare
async function getTwilioNumber(daycareId) {
  const { data } = await supabaseAdmin
    .from('twilio_config')
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
  const body = `Hi ${firstName}! Just a reminder that ${dogName} is scheduled at ${daycareName} on ${dayName}. Reply YES to confirm or NO to cancel.`;
  try {
    await twilioClient.messages.create({ from: fromNumber, to: toPhone, body });
    return true;
  } catch (err) {
    console.error('Reminder SMS error:', err.message);
    return false;
  }
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

  const daycare = await getDaycareInfo(req.daycareId);
  const fromNumber = await getTwilioNumber(req.daycareId);
  if (!fromNumber) return res.status(400).json({ error: 'No Twilio number assigned.' });

  // Get all pending appointments for this date
  const { data: appts, error } = await supabaseAdmin
    .from('appointments')
    .select('id, client_id, dog_id, status, clients(first_name, phone), dogs(name)')
    .eq('daycare_id', req.daycareId)
    .eq('appointment_date', date)
    .eq('status', 'pending')
    .is('reminder_sent_at', null);

  if (error) return res.status(500).json({ error: error.message });
  if (!appts.length) return res.json({ success: true, sent: 0, message: 'No pending appointments to remind.' });

  let sent = 0, failed = 0;
  for (const appt of appts) {
    if (!appt.clients?.phone) { failed++; continue; }
    const dogName = appt.dogs?.name || 'your pup';
    const ok = await sendReminderSms(
      fromNumber,
      appt.clients.phone,
      appt.clients.first_name,
      dogName,
      daycare.name,
      date
    );
    if (ok) {
      await supabaseAdmin.from('appointments').update({ reminder_sent_at: new Date().toISOString() }).eq('id', appt.id);
      sent++;
    } else {
      failed++;
    }
  }

  res.json({ success: true, sent, failed });
});

// POST /api/appointments/morning-summary — send morning confirmation summary to site manager
router.post('/morning-summary', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { date, manager_phone } = req.body;
  if (!date || !manager_phone) return res.status(400).json({ error: 'date and manager_phone required' });

  const fromNumber = await getTwilioNumber(req.daycareId);
  const daycare = await getDaycareInfo(req.daycareId);
  if (!fromNumber) return res.status(400).json({ error: 'No Twilio number assigned.' });

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
  const body = `${daycare.name} — ${dayName} schedule: ${total} total · ${counts.confirmed} confirmed ✓ · ${counts.pending} no reply · ${counts.cancelled} cancelled. Have a great day!`;

  try {
    await twilioClient.messages.create({ from: fromNumber, to: manager_phone, body });
    res.json({ success: true, summary: body });
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

// ─── INBOUND SMS HANDLER ─────────────────────────────────────────────────────
// POST /api/appointments/inbound — called from Twilio webhook for incoming SMS
// Also handles generic inbound (registered in server.js)
router.post('/inbound', express.urlencoded({ extended: false }), async (req, res) => {
  const { From, To, Body, MessageSid } = req.body;
  const reply = (Body || '').trim().toUpperCase();

  // Find the daycare that owns this Twilio number
  const { data: config } = await supabaseAdmin
    .from('twilio_config')
    .select('daycare_id')
    .eq('phone_number', To)
    .eq('status', 'active')
    .single();

  if (!config) return res.sendStatus(200);

  // Find the client by phone number
  const phone = From.replace(/\s/g, '');
  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('id, first_name')
    .eq('daycare_id', config.daycare_id)
    .eq('phone', phone)
    .eq('active', true)
    .single();

  // Always save inbound message to history (for all replies, not just YES/NO)
  await supabaseAdmin.from('inbound_messages').insert({
    daycare_id: config.daycare_id,
    client_id: client?.id || null,
    from_number: From,
    to_number: To,
    body: Body || '',
    twilio_sid: MessageSid || null,
    read: false,
    received_at: new Date().toISOString()
  });

  // Only process YES/NO for appointment confirmation logic
  if (!['YES', 'NO', 'Y', 'N'].includes(reply)) {
    return res.sendStatus(200);
  }

  const isConfirm = reply === 'YES' || reply === 'Y';

  if (!client) return res.sendStatus(200);

  // Find their most recent pending appointment with a reminder sent
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const { data: appt } = await supabaseAdmin
    .from('appointments')
    .select('id, appointment_date, dogs(name)')
    .eq('daycare_id', config.daycare_id)
    .eq('client_id', client.id)
    .eq('status', 'pending')
    .not('reminder_sent_at', 'is', null)
    .gte('appointment_date', new Date().toISOString().split('T')[0])
    .order('appointment_date', { ascending: true })
    .limit(1)
    .single();

  if (!appt) return res.sendStatus(200);

  const newStatus = isConfirm ? 'confirmed' : 'cancelled';
  await supabaseAdmin
    .from('appointments')
    .update({ status: newStatus, confirmed_at: new Date().toISOString() })
    .eq('id', appt.id);

  // Send acknowledgement
  const { data: daycare } = await supabaseAdmin
    .from('daycares')
    .select('name')
    .eq('id', config.daycare_id)
    .single();

  const fromNumber = To;
  const dogName = appt.dogs?.name || 'your pup';
  const apptDate = new Date(appt.appointment_date + 'T12:00:00');
  const dayStr = apptDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  const ackBody = isConfirm
    ? `Got it, ${client.first_name}! We've confirmed ${dogName} for ${dayStr}. See you then! 🐾`
    : `No problem, ${client.first_name}! We've cancelled ${dogName}'s appointment on ${dayStr}. See you next time!`;

  try {
    await twilioClient.messages.create({ from: fromNumber, to: From, body: ackBody });
  } catch (err) {
    console.error('Ack SMS error:', err.message);
  }

  res.sendStatus(200);
});

module.exports = router;
