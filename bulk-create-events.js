const { google } = require('googleapis');
const https = require('https');

const CALENDAR_ID = process.env.CALENDAR_ID;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const TODAY = new Date().toISOString().split('T')[0];

const SA = JSON.parse(process.env.GOOGLE_SA_JSON);

const FAMILIES = {
  'xavier-lourdes': 'Xavier / Lourdes',
  'Josep-mariona': 'Josep / Mariona',
  'anna-roger': 'Anna / Roger',
  'xavi-maria': 'Xavi / Maria',
  'jordi-helena': 'Jordi / Helena',
  'mire-guido': 'Mire / Guido',
  'gloria': 'Glòria',
  'bernat': 'Bernat',
};

const SPACES = { barbacoa: 'Barbacoa', piscina: 'Piscina', menjador: 'Menjador/Cuina' };
const MONTHS_CA = ['Gener','Febrer','Març','Abril','Maig','Juny','Juliol','Agost','Setembre','Octubre','Novembre','Desembre'];
const DAY_NAMES = ['Diumenge','Dilluns','Dimarts','Dimecres','Dijous','Divendres','Dissabte'];

function getFamilyLabel(family) {
  const families = Array.isArray(family) ? family : [family];
  return families.map(id => FAMILIES[id] || id).join(', ');
}

function getSpacesLabel(spaces) {
  return (spaces || []).map(s => SPACES[s] || s).join(' + ') || 'No especificat';
}

function reservationToEvent(r) {
  const date = new Date(`${r.date}T00:00:00`);
  const dayName = DAY_NAMES[date.getDay()];
  const dateLabel = `${dayName}, ${date.getDate()} ${MONTHS_CA[date.getMonth()]} ${date.getFullYear()}`;
  const familyLabel = getFamilyLabel(r.family);
  const spacesLabel = getSpacesLabel(r.spaces);
  const total = (Number(r.adults)||0) + (Number(r.children)||0);

  const description = [
    `👨‍👩‍👧 Família: ${familyLabel}`,
    `🏠 Espais: ${spacesLabel}`,
    `👥 Persones: ${r.adults} adults · ${r.children} nens (${total} total)`,
    r.timeRange ? `🕐 Horari: ${r.timeRange}` : '',
    '',
    `📅 ${dateLabel}`,
    '',
    "📱 Creat des d'AppMoltures",
  ].filter(s => s !== null).join('\n');

  const summary = r.title || `${familyLabel} · ${spacesLabel}`;

  if (r.timeRange && r.timeRange.includes('-')) {
    const parts = r.timeRange.split('-').map(s => s.trim());
    return {
      summary, description,
      start: { dateTime: `${r.date}T${parts[0]}:00`, timeZone: 'Europe/Madrid' },
      end:   { dateTime: `${r.date}T${parts[1]}:00`, timeZone: 'Europe/Madrid' },
    };
  }
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  return {
    summary, description,
    start: { date: r.date },
    end:   { date: nextDay.toISOString().split('T')[0] },
  };
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    }).on('error', reject);
  });
}

function httpsPut(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: SA,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const cal = google.calendar({ version: 'v3', auth });

  // First: verify calendar access
  console.log('Verifying calendar access...');
  console.log('Service account:', SA.client_email);
  console.log('Calendar ID:', CALENDAR_ID);
  try {
    const calInfo = await cal.calendars.get({ calendarId: CALENDAR_ID });
    console.log('✓ Calendar accessible:', calInfo.data.summary);
  } catch (err) {
    console.error('✗ Cannot access calendar:', err.message);
    console.error('  → You must share the calendar with:', SA.client_email);
    console.error('  → Permission needed: "Make changes to events"');
    process.exit(1);
  }

  // Fetch reservations
  console.log('\nFetching reservations from Firebase...');
  const dbHost = new URL(FIREBASE_DB_URL).hostname;
  const reservations = await httpsGet(`${FIREBASE_DB_URL}/reservations.json`);

  if (!reservations || typeof reservations !== 'object') {
    console.log('No reservations found'); return;
  }

  const upcoming = Object.entries(reservations)
    .filter(([, r]) => r.date >= TODAY)
    .sort((a, b) => a[1].date.localeCompare(b[1].date));

  console.log(`Found ${upcoming.length} upcoming reservations`);

  let created = 0, skipped = 0, errors = 0;

  for (const [id, r] of upcoming) {
    if (r.googleEventId) {
      console.log(`  SKIP ${r.date} "${r.title}" (already synced: ${r.googleEventId})`);
      skipped++; continue;
    }
    try {
      const eventBody = reservationToEvent(r);
      console.log(`  CREATE ${r.date} "${eventBody.summary}"`);
      const response = await cal.events.insert({ calendarId: CALENDAR_ID, requestBody: eventBody });
      const googleEventId = response.data.id;
      console.log(`    ✓ Created: ${googleEventId}`);

      // Save googleEventId to Firebase
      await httpsPut(dbHost, `/reservations/${id}/googleEventId.json`, googleEventId);
      console.log('    ✓ Saved to Firebase');

      created++;
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.error(`  ERROR ${r.date} "${r.title}": ${err.message}`);
      errors++;
    }
  }

  console.log(`\nDone! Created: ${created} | Skipped: ${skipped} | Errors: ${errors}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
