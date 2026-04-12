const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

// Simple CSV parser — handles quoted fields with commas inside
// Lines starting with ## are treated as comments and skipped (used in the template for instructions)
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.trim().startsWith('##')) continue; // skip template instruction comments
    const cols = [];
    let cur = '', inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuote = !inQuote; continue; }
      if (ch === ',' && !inQuote) { cols.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  return rows;
}

// Normalize a column header: lowercase, remove spaces/underscores/special chars
function norm(s) {
  return (s || '').toLowerCase().replace(/[\s_\-()\/]+/g, '');
}

// Map any reasonable column name to our canonical field names
const COLUMN_MAP = {
  // Owner first name
  ownerfirstname:  'owner_first', clientfirstname: 'owner_first', firstname: 'owner_first',
  first: 'owner_first', fname: 'owner_first',
  // Owner last name
  ownerlastname:   'owner_last', clientlastname: 'owner_last', lastname: 'owner_last',
  last: 'owner_last', lname: 'owner_last', surname: 'owner_last',
  // Phone
  ownerphone: 'owner_phone', clientphone: 'owner_phone', phone: 'owner_phone',
  phonenumber: 'owner_phone', mobile: 'owner_phone', cell: 'owner_phone',
  primaryphone: 'owner_phone',
  // Email
  owneremail: 'owner_email', clientemail: 'owner_email', email: 'owner_email',
  emailaddress: 'owner_email',
  // Dog name
  dogname: 'dog_name', petname: 'dog_name', dog: 'dog_name', pet: 'dog_name',
  name: 'dog_name', animalname: 'dog_name',
  // Breed
  breed: 'dog_breed', dogbreed: 'dog_breed', petbreed: 'dog_breed', species: 'dog_breed',
  // Age
  age: 'dog_age', dogage: 'dog_age', ageyears: 'dog_age', petage: 'dog_age',
  // Weight
  weight: 'dog_weight', weightlbs: 'dog_weight', lbs: 'dog_weight', dogweight: 'dog_weight',
  // Sex
  sex: 'dog_sex', gender: 'dog_sex',
  // Color
  color: 'dog_color', colour: 'dog_color', dogcolor: 'dog_color',
  // Notes
  notes: 'dog_notes', dognotes: 'dog_notes', petnotes: 'dog_notes', comments: 'dog_notes',
  // Medications
  medications: 'dog_meds', meds: 'dog_meds', medication: 'dog_meds',
  dogmedications: 'dog_meds', vetmeds: 'dog_meds',
  // Gingr owner fields
  ownerid: 'gingr_owner_id',
  cellphone: 'owner_phone', // cell already mapped above
  ownerdetails: 'owner_notes', details: 'owner_notes',
  address: 'owner_address',
  // Gingr animal fields
  animalid: 'gingr_animal_id',
  afirst: 'dog_name', animalfirstname: 'dog_name',
  personality: 'dog_personality',
  vaccinationrecords: 'dog_vaccinations', vaccinations: 'dog_vaccinations',
  // Gingr reservation fields
  checkinstamp: 'appt_checkin', checkoutstamp: 'appt_checkout',
  startdate: 'appt_start', enddate: 'appt_end',
  typename: 'appt_type',
  statusstring: 'appt_status',
  runname: 'appt_run', areaname: 'appt_area',
  olast: 'res_owner_last',
};

function cleanPhone(p) {
  if (!p) return null;
  const digits = (p + '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return p; // return as-is if can't normalize
}

// POST /api/import/preview — parse CSV, return preview without saving
router.post('/preview', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv text required' });

  const rows = parseCSV(csv);
  if (rows.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });

  const headers = rows[0].map(norm);
  const mapped = headers.map(h => COLUMN_MAP[h] || null);

  // Detect unmapped critical columns
  const hasOwnerFirst = mapped.includes('owner_first');
  const hasOwnerLast  = mapped.includes('owner_last');
  const hasPhone      = mapped.includes('owner_phone');
  const hasDogName    = mapped.includes('dog_name');

  const warnings = [];
  if (!hasOwnerFirst) warnings.push('Could not find owner first name column');
  if (!hasOwnerLast)  warnings.push('Could not find owner last name column');
  if (!hasPhone)      warnings.push('Could not find phone number column');
  if (!hasDogName)    warnings.push('Could not find dog name column');

  const preview = [];
  for (let i = 1; i < Math.min(rows.length, 6); i++) {
    const row = rows[i];
    const obj = {};
    mapped.forEach((field, idx) => { if (field) obj[field] = row[idx] || ''; });
    preview.push(obj);
  }

  res.json({
    total_rows: rows.length - 1,
    headers: rows[0],
    mapped_headers: mapped,
    warnings,
    preview
  });
});

// POST /api/import/clients — import CSV data into clients + dogs tables
router.post('/clients', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });
  const { csv, skip_duplicates = true } = req.body;
  if (!csv) return res.status(400).json({ error: 'csv text required' });

  const rows = parseCSV(csv);
  if (rows.length < 2) return res.status(400).json({ error: 'No data rows found' });

  const headers = rows[0].map(norm);
  const mapped  = headers.map(h => COLUMN_MAP[h] || null);

  // Parse all rows into objects
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every(c => !c.trim())) continue; // skip blank rows
    const obj = {};
    mapped.forEach((field, idx) => { if (field) obj[field] = (row[idx] || '').trim(); });
    records.push(obj);
  }

  // Group by normalized phone (deduplicate owners)
  const ownerMap = new Map(); // phone → { owner fields, dogs[] }
  for (const rec of records) {
    const phone = cleanPhone(rec.owner_phone);
    const key   = phone || `${rec.owner_first}|${rec.owner_last}`.toLowerCase();
    if (!ownerMap.has(key)) {
      ownerMap.set(key, {
        first_name: rec.owner_first || '',
        last_name:  rec.owner_last  || '',
        phone:      phone || rec.owner_phone || '',
        email:      rec.owner_email || null,
        dogs: []
      });
    }
    // Add dog if there's a dog name
    if (rec.dog_name) {
      ownerMap.get(key).dogs.push({
        name:        rec.dog_name,
        breed:       rec.dog_breed  || null,
        age:         rec.dog_age    ? parseFloat(rec.dog_age)   : null,
        weight:      rec.dog_weight ? parseFloat(rec.dog_weight): null,
        notes:       [rec.dog_color, rec.dog_sex, rec.dog_notes].filter(Boolean).join(' · ') || null,
        medications: rec.dog_meds   || null,
      });
    }
  }

  const results = { clients_created: 0, clients_skipped: 0, dogs_created: 0, dogs_skipped: 0, errors: [] };

  for (const [, owner] of ownerMap) {
    if (!owner.first_name && !owner.last_name) { results.errors.push('Row missing owner name — skipped'); continue; }

    // Upsert client by phone within this daycare
    let clientId;
    try {
      if (owner.phone) {
        // Check for existing client with same phone
        const { data: existing } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('daycare_id', req.daycareId)
          .eq('phone', owner.phone)
          .single();

        if (existing) {
          if (skip_duplicates) { results.clients_skipped++; clientId = existing.id; }
          else {
            await supabaseAdmin.from('clients').update({
              first_name: owner.first_name,
              last_name:  owner.last_name,
              email:      owner.email,
            }).eq('id', existing.id);
            clientId = existing.id;
          }
        }
      }

      if (!clientId) {
        const { data: created, error } = await supabaseAdmin
          .from('clients')
          .insert({
            daycare_id: req.daycareId,
            first_name: owner.first_name,
            last_name:  owner.last_name,
            phone:      owner.phone || null,
            email:      owner.email,
            active:     true
          })
          .select('id')
          .single();
        if (error) throw error;
        clientId = created.id;
        results.clients_created++;
      }
    } catch (err) {
      results.errors.push(`Client "${owner.first_name} ${owner.last_name}": ${err.message}`);
      continue;
    }

    // Insert dogs for this client
    for (const dog of owner.dogs) {
      try {
        // Check for duplicate dog name under same client
        const { data: existingDog } = await supabaseAdmin
          .from('dogs')
          .select('id')
          .eq('client_id', clientId)
          .eq('daycare_id', req.daycareId)
          .ilike('name', dog.name)
          .single();

        if (existingDog) { results.dogs_skipped++; continue; }

        const { error } = await supabaseAdmin
          .from('dogs')
          .insert({ ...dog, client_id: clientId, daycare_id: req.daycareId, active: true });
        if (error) throw error;
        results.dogs_created++;
      } catch (err) {
        results.errors.push(`Dog "${dog.name}": ${err.message}`);
      }
    }
  }

  res.json({ success: true, ...results });
});

// POST /api/import/gingr
// Body: { owners: [], animals: [], reservations: [], import_appointments: boolean }
router.post('/gingr', requireAuth, async (req, res) => {
  if (!req.daycareId) return res.status(403).json({ error: 'No daycare associated' });

  const { owners = [], animals = [], reservations = [], import_appointments = false } = req.body;

  // ── Step 1: Build lookup maps ─────────────────────────────────────────────
  const ownerById = new Map(); // gingr_owner_id → owner row
  for (const o of owners) {
    if (o.gingr_owner_id) ownerById.set(String(o.gingr_owner_id), o);
  }

  // From reservations, build animal → owner link
  const animalOwnerMap = new Map(); // gingr_animal_id → gingr_owner_id
  for (const r of reservations) {
    const aid = String(r.animal_id || '');
    const oid = String(r.owner_id || '');
    if (aid && oid && !animalOwnerMap.has(aid)) {
      animalOwnerMap.set(aid, oid);
    }
  }

  let clients_created = 0, clients_skipped = 0;
  let dogs_created = 0, dogs_skipped = 0;
  let unlinked_animals = 0;
  let appointments_created = 0, appointments_skipped = 0;
  const errors = [];

  // ── Step 2: Insert clients (from owners) ──────────────────────────────────
  const clientIdMap = new Map(); // gingr_owner_id → tailwag_client_id

  for (const owner of owners) {
    const gingrOwnerId = String(owner.gingr_owner_id || '');
    if (!gingrOwnerId) continue;
    if (!owner.first_name && !owner.last_name) {
      errors.push(`Owner id ${gingrOwnerId}: missing name — skipped`);
      continue;
    }

    const phone = cleanPhone(owner.phone);
    let clientId;

    try {
      if (phone) {
        const { data: existing } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('daycare_id', req.daycareId)
          .eq('phone', phone)
          .single();

        if (existing) {
          clients_skipped++;
          clientId = existing.id;
        }
      }

      if (!clientId) {
        // Also try matching by email if no phone match
        if (!phone && owner.email) {
          const { data: existingByEmail } = await supabaseAdmin
            .from('clients')
            .select('id')
            .eq('daycare_id', req.daycareId)
            .eq('email', owner.email)
            .single();
          if (existingByEmail) {
            clients_skipped++;
            clientId = existingByEmail.id;
          }
        }
      }

      if (!clientId) {
        const insertData = {
          daycare_id: req.daycareId,
          first_name: owner.first_name || '',
          last_name:  owner.last_name  || '',
          phone:      phone || null,
          email:      owner.email || null,
          active:     true,
        };
        if (owner.notes) insertData.notes = owner.notes;
        if (owner.address) insertData.address = owner.address;

        const { data: created, error } = await supabaseAdmin
          .from('clients')
          .insert(insertData)
          .select('id')
          .single();
        if (error) throw error;
        clientId = created.id;
        clients_created++;
      }

      clientIdMap.set(gingrOwnerId, clientId);
    } catch (err) {
      errors.push(`Client "${owner.first_name} ${owner.last_name}": ${err.message}`);
    }
  }

  // ── Step 3: Insert dogs (from animals) ────────────────────────────────────
  const dogIdMap = new Map(); // gingr_animal_id → tailwag_dog_id

  for (const animal of animals) {
    const gingrAnimalId = String(animal.gingr_animal_id || '');
    if (!gingrAnimalId) continue;

    const gingrOwnerId = animalOwnerMap.get(gingrAnimalId);
    if (!gingrOwnerId) {
      unlinked_animals++;
      continue;
    }

    const clientId = clientIdMap.get(String(gingrOwnerId));
    if (!clientId) {
      unlinked_animals++;
      continue;
    }

    const dogName = animal.name || '';
    if (!dogName) { errors.push(`Animal id ${gingrAnimalId}: no name — skipped`); continue; }

    try {
      const { data: existingDog } = await supabaseAdmin
        .from('dogs')
        .select('id')
        .eq('client_id', clientId)
        .eq('daycare_id', req.daycareId)
        .ilike('name', dogName)
        .single();

      if (existingDog) {
        dogs_skipped++;
        dogIdMap.set(gingrAnimalId, existingDog.id);
        continue;
      }

      const dogNotes = [animal.personality, animal.vaccinations].filter(Boolean).join(' · ') || null;

      const { data: created, error } = await supabaseAdmin
        .from('dogs')
        .insert({
          client_id:  clientId,
          daycare_id: req.daycareId,
          name:       dogName,
          breed:      animal.breed || null,
          notes:      dogNotes,
          active:     true,
        })
        .select('id')
        .single();
      if (error) throw error;
      dogs_created++;
      dogIdMap.set(gingrAnimalId, created.id);
    } catch (err) {
      errors.push(`Dog "${dogName}": ${err.message}`);
    }
  }

  // ── Step 4: Insert appointments ───────────────────────────────────────────
  if (import_appointments) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 365);

    for (const r of reservations) {
      const rawDate = r.check_in || r.check_out || '';
      let apptDate;
      try {
        apptDate = rawDate ? new Date(rawDate) : null;
        if (!apptDate || isNaN(apptDate.getTime())) {
          appointments_skipped++;
          continue;
        }
      } catch {
        appointments_skipped++;
        continue;
      }

      if (apptDate < cutoff) { appointments_skipped++; continue; }

      const clientId = clientIdMap.get(String(r.owner_id || ''));
      if (!clientId) { appointments_skipped++; continue; }

      const dogId = dogIdMap.get(String(r.animal_id || '')) || null;

      // Map status
      const rawStatus = (r.status || '').toLowerCase();
      let status = 'scheduled';
      if (['checked_out', 'completed', 'checked out'].includes(rawStatus)) status = 'completed';
      else if (['checked_in', 'checked in', 'in_progress'].includes(rawStatus)) status = 'confirmed';
      else if (['cancelled', 'canceled'].includes(rawStatus)) status = 'cancelled';

      const notes = [r.type, r.area_name, r.run_name].filter(Boolean).join(' · ') || null;

      try {
        const { error } = await supabaseAdmin
          .from('appointments')
          .insert({
            daycare_id:       req.daycareId,
            client_id:        clientId,
            dog_id:           dogId,
            appointment_date: apptDate.toISOString(),
            status,
            notes,
            created_by:       req.user.id,
          });
        if (error) throw error;
        appointments_created++;
      } catch (err) {
        appointments_skipped++;
        if (errors.length < 20) errors.push(`Appointment (client ${r.owner_id}): ${err.message}`);
      }
    }
  }

  res.json({
    success: true,
    clients_created,
    clients_skipped,
    dogs_created,
    dogs_skipped,
    unlinked_animals,
    appointments_created,
    appointments_skipped,
    errors: errors.slice(0, 20),
  });
});

module.exports = router;
