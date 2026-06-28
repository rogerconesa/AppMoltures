const functions = require('firebase-functions');
const { google } = require('googleapis');
const admin = require('firebase-admin');

// Init Firebase Admin (uses service account automatically in Cloud Functions)
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.database();

// ── Configuració ──────────────────────────────────────────────
const CALENDAR_ID = '0bbe1cd5f3cb16c6151ccd45f1fbdeb84175b7071d0ecf2bf74ec83e15324e17@group.calendar.google.com';

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'appmoltures-500809',
  private_key_id: 'ca2a8ca167ad079101d98a86dd4eb9bc9383e92c',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDDyDUV1GyrKqKD\nfWPw109RLHwDZ78uMMw215BMj/6PG1S1mrEo6BIfhDqq0jZ7dykQaZgzrEYiptbz\njfIdJi4fbbJPf8A3DrxK0ddvhvCFp1bvvtWLVN87ia4LziDzdZBv0Ec9m6jndf8F\nwn1mCIRYAgYZlvKaltpC4XfZxOhRukhM9MEZVbK01XWB9ouUdNljiWh8k0qLo67U\n5gkQTS3F+T0wSze4HQeOl9wQvMaIOhPGy/WOReQLjLcbHhw5wSS9whV0rQ/d0sdP\n8g6okZTIhSJNT1+20WRK0eb36oqXG1OXDQrkq8KKrpAwG1IkR2XQjdc5ayiGmJ1W\nVOzUBQ4jAgMBAAECggEAHoAXs7rADTBwrfRrDUULFcsiLMj3seNR79ny9dfZoVjG\n1ciaKz8a568KvBGmAY5lptQUgo78RCoNbaxiQ3lEZoqz5Ipd8Gs1bqCJ+VV32L03\noCpGNqp2YTOd7402zpw08BPDWCKNFItqO0RP6IU7fOx1H9JyIXQ5NNckUUL0VcWI\n68HQXoJfMc/ihbAXkU6jUZiYHB2hcydiWNPWRyCq/yaOj03DJ6Zp1IiOTf/b7J4O\n09ROD0vAsaE8rtRCT2g6QziG2kfyveeSJlR7+l40GqSjjdmJNaq7995DBGEWFjQh\n6Tx/eKOjnEtju0KZDBbjclg+dEgst1Al8xftku3w+QKBgQDpvbu9swzsKTE3Rllj\n/NqMb5CcsjOVpzTYLERIY6QWl+epg10K3UeKKaH5K4F3HOnQDjI03m1qWmi4SPvK\na92IA1/jmmF2CvNSOrOBpvnVJ78Cm6orwU30LgAKN63ZwurnV2fk9Lhji7Xmq8rk\nIUB7+vxmETp5hquA6YHcy0kwmQKBgQDWbRZMrZ0G6fFA1ra6T25J41zTx5a71sjO\nxZiNVAepcLwLbGYc5+Zflkmu3JGYcooYOIQKn35pCIdo3FlT/4wFUQ7GvOBJ0AGx\nwYCr1YVZZbkZ8aX2SObz5fPPnwhSFYwLR1p6KUImrXTJF/hYjE7bmEUxeRAMzSWM\nxmh5PlMeGwKBgQDM2TecPTtqDX/QjZryAjwXL/9xFMwYr/2kJseBGbJJCsBA05vL\nVbrI30vQ78v69CAF8ysVIoqJ1spIF85zzKzN8wcqlbYsmdQ9kKyZSBlUMg043+v3\nhOYoxdfLHJkEa8srDHNFOSQQOfUlQBIEdQ/qmEBzw02YC+pqhDsHojF2oQKBgDRh\nzdLJjtTDjcYzLcxx3xV5z5GE7pPQspmgt9W+s2h3O9jmkEN7e1HamwF2rLK7OHUW\nSVt2/yCVjs7VFZVplkEuPhfayEf/4ooUJWTU8pCWQxPNbqetw43NnTQZO6Uh0mZm\n9fll3t0n/qGpk2e+Tv1iQ3UEiCE4dHXhemA0E4YFAoGAXApDDvYq6OtIRqXgcrfA\nRoAHHIPl3iHBlp0AVCHwknHJmtY9DAgN5rU851Y7g3jA0iWe6xWxMn5GgKsqKXwZ\n3edXmmJQ+xMqqicGvK5nidvrjsY9vtvIdkJWijaDq6mLCJ9b9v3frGTcyjMrNUm5\nx+SZkhUsG81kUC+/lmXLX4Q=\n-----END PRIVATE KEY-----\n',
  client_email: 'appmoltures-calendar@appmoltures-500809.iam.gserviceaccount.com',
  client_id: '104444524817446577227',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
};

// ── Helpers ───────────────────────────────────────────────────

function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Converteix una reserva d'AppMoltures a un event de Google Calendar.
 * L'event dura tot el dia si no hi ha timeRange; si hi ha, posa hora d'inici/fi.
 */
function reservationToGCalEvent(r) {
  const MONTHS_CA = ['Gener','Febrer','Març','Abril','Maig','Juny',
    'Juliol','Agost','Setembre','Octubre','Novembre','Desembre'];
  const DAY_NAMES = ['Diumenge','Dilluns','Dimarts','Dimecres','Dijous','Divendres','Dissabte'];

  const date = new Date(`${r.date}T00:00:00`);
  const dayName = DAY_NAMES[date.getDay()];
  const dateLabel = `${dayName}, ${date.getDate()} ${MONTHS_CA[date.getMonth()]} ${date.getFullYear()}`;

  const families = Array.isArray(r.family) ? r.family : [r.family];
  const familyLabel = families.map(id => {
    const map = {
      'xavier-lourdes': 'Xavier / Lourdes',
      'Josep-mariona': 'Josep / Mariona',
      'anna-roger': 'Anna / Roger',
      'xavi-maria': 'Xavi / Maria',
      'jordi-helena': 'Jordi / Helena',
      'mire-guido': 'Mire / Guido',
      'gloria': 'Glòria',
      'bernat': 'Bernat',
    };
    return map[id] || id;
  }).join(', ');

  const spaceMap = { barbacoa: 'Barbacoa', piscina: 'Piscina', menjador: 'Menjador/Cuina' };
  const spacesLabel = (r.spaces || []).map(s => spaceMap[s] || s).join(' + ');

  const total = (Number(r.adults) || 0) + (Number(r.children) || 0);
  const description = [
    `👨‍👩‍👧 Família: ${familyLabel}`,
    `🏠 Espais: ${spacesLabel || 'No especificat'}`,
    `👥 Persones: ${r.adults} adults · ${r.children} nens (${total} total)`,
    r.timeRange ? `🕐 Horari: ${r.timeRange}` : '',
    '',
    '📱 Creat des d\'AppMoltures',
  ].filter(s => s !== null && s !== undefined).join('\n');

  // Si hi ha rang d'hores, usem dateTime; si no, allDay
  if (r.timeRange && r.timeRange.includes('-')) {
    const parts = r.timeRange.split('-').map(s => s.trim());
    const startTime = parts[0]; // "11:00"
    const endTime = parts[1];   // "18:00"
    return {
      summary: r.title || `${familyLabel} · ${spacesLabel}`,
      description,
      start: { dateTime: `${r.date}T${startTime}:00`, timeZone: 'Europe/Madrid' },
      end:   { dateTime: `${r.date}T${endTime}:00`,   timeZone: 'Europe/Madrid' },
    };
  }

  // Event d'un dia sencer
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = nextDay.toISOString().split('T')[0];

  return {
    summary: r.title || `${familyLabel} · ${spacesLabel}`,
    description,
    start: { date: r.date },
    end:   { date: nextDayStr },
  };
}

// ── Cloud Function principal ──────────────────────────────────

exports.calendarEvent = functions
  .region('europe-west1')
  .https.onRequest(async (req, res) => {
    // CORS
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const { action, reservation, googleEventId } = req.body;

    if (!action || !reservation) {
      res.status(400).json({ error: 'action i reservation són obligatoris' });
      return;
    }

    try {
      const cal = getCalendarClient();
      const eventBody = reservationToGCalEvent(reservation);

      if (action === 'create') {
        const response = await cal.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: eventBody,
        });
        const googleEventId = response.data.id;
        // Save googleEventId to Firebase RTDB
        if (reservation.firebaseId) {
          await db.ref(`reservations/${reservation.firebaseId}/googleEventId`).set(googleEventId);
          console.log(`Saved googleEventId ${googleEventId} to Firebase for ${reservation.firebaseId}`);
        }
        res.json({ success: true, googleEventId });

      } else if (action === 'update') {
        if (!googleEventId) { res.status(400).json({ error: 'googleEventId obligatori per update' }); return; }
        // Intenta update; si l'event no existeix (404), crea'l de nou
        try {
          const response = await cal.events.update({
            calendarId: CALENDAR_ID,
            eventId: googleEventId,
            requestBody: eventBody,
          });
          res.json({ success: true, googleEventId: response.data.id });
        } catch (err) {
          if (err.code === 404 || err.status === 404) {
            const response = await cal.events.insert({
              calendarId: CALENDAR_ID,
              requestBody: eventBody,
            });
            res.json({ success: true, googleEventId: response.data.id });
          } else { throw err; }
        }

      } else if (action === 'delete') {
        if (!googleEventId) { res.status(400).json({ error: 'googleEventId obligatori per delete' }); return; }
        try {
          await cal.events.delete({ calendarId: CALENDAR_ID, eventId: googleEventId });
        } catch (err) {
          // Si ja no existeix, no és un error crític
          if (err.code !== 404 && err.status !== 404) throw err;
        }
        res.json({ success: true });

      } else {
        res.status(400).json({ error: `Acció desconeguda: ${action}` });
      }

    } catch (err) {
      console.error('Calendar error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
