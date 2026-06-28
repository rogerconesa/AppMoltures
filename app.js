const firebaseConfig = {
  apiKey: "AIzaSyBQoKsQbGnsIOGQIwSZuOoh2unePekG9s8",
  authDomain: "appmoltures.firebaseapp.com",
  databaseURL: "https://appmoltures-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "appmoltures",
  storageBucket: "appmoltures.firebasestorage.app",
  messagingSenderId: "703957690397",
  appId: "1:703957690397:web:77448ede264b3d4979bef4"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const reservationsRef = db.ref('reservations');
const feedbackRef = db.ref('feedback');

// ── Google Calendar Cloud Function ──────────────────────────
const CALENDAR_FUNCTION_URL = 'https://europe-west1-appmoltures.cloudfunctions.net/calendarEvent';

async function syncCalendar(action, reservation, googleEventId) {
  try {
    const body = { action, reservation };
    if (googleEventId) body.googleEventId = googleEventId;
    const resp = await fetch(CALENDAR_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) { console.warn('Calendar sync error:', await resp.text()); return null; }
    const data = await resp.json();
    return data.googleEventId || null;
  } catch (e) {
    console.warn('Calendar sync failed:', e.message);
    return null;
  }
}

const DAY_NAMES = ['Dilluns', 'Dimarts', 'Dimecres', 'Dijous', 'Divendres', 'Dissabte', 'Diumenge'];
const DAY_SHORT = ['Dl', 'Dt', 'Dc', 'Dj', 'Dv', 'Ds', 'Dg'];
const MONTHS_CA = ['Gener', 'Febrer', 'Març', 'Abril', 'Maig', 'Juny', 'Juliol', 'Agost', 'Setembre', 'Octubre', 'Novembre', 'Desembre'];

const FAMILIES = [
  { id: 'xavier-lourdes', name: 'Xavier / Lourdes' },
  { id: 'josep-mariona', name: 'Josep / Mariona' },
  { id: 'anna-roger', name: 'Anna / Roger' },
  { id: 'xavi-maria', name: 'Xavi / Maria' },
  { id: 'jordi-helena', name: 'Jordi / Helena' },
  { id: 'mire-guido', name: 'Mire / Guido' },
  { id: 'gloria', name: 'Glòria' },
  { id: 'bernat', name: 'Bernat' }
];

const SLOTS = [
  { id: 'dinar', name: 'Dinar', note: 'Reserva de migdia' },
  { id: 'sopar', name: 'Sopar', note: 'Reserva de vespre' }
];

const SPACES = [
  { id: 'barbacoa', name: 'Barbacoa', note: 'Zona de taules i brasa' },
  { id: 'piscina', name: 'Piscina', note: 'Espai de bany i gandules' },
  { id: 'menjador', name: 'Menjador/Cuina', note: 'Menjador i cuina comunitària' }
];

let reservations = {};
let feedbacks = {};
let currentView = 'summary';
let weekOffset = 0;
let monthOffset = 0;
let editingId = null;
let selectedFamilies = new Set();
let selectedSpaces = new Set();
let activeDay = null;
let notifTimer = null;
let rtdbReady = false;
let feedbackTab = 'submit';

// Historic state
let historicFilter = { family: '', space: '', dateFrom: '', dateTo: '' };
let historicSort = { col: 'date', dir: 'desc' };
let _chartInstances = {};

const today = new Date();
today.setHours(0, 0, 0, 0);

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(str) {
  return new Date(`${str}T00:00:00`);
}

function escapeHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDateLabel(date) {
  return `${DAY_NAMES[(date.getDay() + 6) % 7]}, ${date.getDate()} ${MONTHS_CA[date.getMonth()]} ${date.getFullYear()}`;
}

function getFamilyName(id) {
  const f = FAMILIES.find((x) => x.id === id);
  return f ? f.name : id;
}
function getFamiliesLabel(arr) {
  if (!arr || !arr.length) return 'Cap família';
  return arr.map(id => getFamilyName(id)).join(', ');
}

function getSlotName(id) {
  const s = SLOTS.find((x) => x.id === id);
  return s ? s.name : id;
}

function getSpaceName(id) {
  const s = SPACES.find((x) => x.id === id);
  return s ? s.name : id;
}

function getSpacesLabel(arr) {
  if (!arr || !arr.length) return 'Sense espais';
  return arr.map(getSpaceName).join(' + ');
}

function getTotalPeople(r) {
  return Number(r.adults || 0) + Number(r.children || 0);
}

function getCapColor(total) {
  if (total <= 6) return 'blue';
  if (total <= 12) return 'yellow';
  if (total <= 25) return 'red';
  return 'purple';
}

function getCapLabel(total) {
  if (total <= 6) return 'Aforament petit';
  if (total <= 12) return 'Aforament mitjà';
  if (total <= 25) return 'Aforament alt';
  return 'Aforament molt alt';
}

function getFamilyInitials(family) {
  // Handles both string ID and array of IDs
  const ids = Array.isArray(family) ? family : [family];
  return ids
    .map(id => getFamilyName(id).split(/[\/\s]+/).filter(Boolean).map(p => p[0]).join(''))
    .join('')
    .slice(0, 3)
    .toUpperCase();
}

function getEventTitle(r) {
  const familyLabel = Array.isArray(r.family) ? getFamiliesLabel(r.family) : getFamilyName(r.family);
  return r.title || (r.slot ? `${getSlotName(r.slot)} · ${familyLabel}` : 'Esdeveniment sense títol');
}

function getEventTimeLabel(r) {
  return r.timeRange || (r.slot ? getSlotName(r.slot) : 'Horari no indicat');
}

function buildWhatsAppMessage(r) {
  const total = getTotalPeople(r);
  const date = parseDate(r.date);
  const lines = [
    '📅 AppMoltures',
    '',
    `Esdeveniment: ${getEventTitle(r)}`,
    `Data: ${formatDateLabel(date)}`,
    r.timeRange ? `Horari: ${r.timeRange}` : '',
    `Qui el crea: ${Array.isArray(r.family) ? getFamiliesLabel(r.family) : getFamilyName(r.family)}`,
    `Espais: ${getSpacesLabel(r.spaces)}`,
    `Persones: ${r.adults} adults · ${r.children} nens (${total} total)`,
    '',
    'Obre AppMoltures per veure\'n els detalls.'
  ].filter(Boolean);

  if (window.location.protocol.startsWith('http')) lines.push(window.location.href.split('#')[0]);
  return lines.join('\n');
}

function shareReservationWhatsApp(id) {
  const r = reservations[id];
  if (!r) { showNotif('No s\'ha trobat l\'esdeveniment', 'error'); return; }
  const url = `https://wa.me/?text=${encodeURIComponent(buildWhatsAppMessage(r))}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function shareFromModal() {
  if (editingId && reservations[editingId]) {
    shareReservationWhatsApp(editingId);
    return;
  }
  const title = document.getElementById('inputTitle').value.trim();
  const date = document.getElementById('inputDate').value;
  const timeRange = document.getElementById('inputTimeRange').value.trim();
  if (!title || !date) { showNotif('Completa títol i data per compartir', 'error'); return; }
  const r = { title, date, timeRange, family: Array.from(selectedFamilies), spaces: Array.from(selectedSpaces), adults: Number(document.getElementById('inputAdults').value)||0, children: Number(document.getElementById('inputChildren').value)||0 };
  r.totalPeople = r.adults + r.children;
  const url = `https://wa.me/?text=${encodeURIComponent(buildWhatsAppMessage(r))}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function isWeekend(date) {
  return ((date.getDay() + 6) % 7) >= 5;
}

function isToday(date) {
  return dateKey(date) === dateKey(today);
}

function showNotif(msg, type) {
  const el = document.getElementById('notif');
  el.textContent = msg;
  el.className = `notif show ${type || ''}`.trim();
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function showView(view) {
  currentView = view;
  document.getElementById('view-summary').classList.toggle('active', view === 'summary');
  document.getElementById('view-month').classList.toggle('active', view === 'month');
  document.getElementById('view-historic').classList.toggle('active', view === 'historic');

  // Bottom nav tabs
  document.querySelectorAll('#bottom-nav .nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.view === view);
  });

  if (view === 'historic') renderHistoric();
}

function getWeekDates(offset) {
  const start = new Date(today);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function getReservationFor(dateStr, slotId, ignoreId) {
  return Object.entries(reservations).find(([id, r]) => {
    if (ignoreId && id === ignoreId) return false;
    return r.date === dateStr && r.slot === slotId;
  });
}

function getReservationsForDate(dateStr) {
  return Object.entries(reservations)
    .filter(([, r]) => r.date === dateStr)
    .sort((a, b) => String(a[1].timeRange || a[1].slot || '').localeCompare(String(b[1].timeRange || b[1].slot || '')));
}

function getUpcomingReservations() {
  const todayKey = dateKey(today);
  return Object.entries(reservations)
    .filter(([, r]) => r.date >= todayKey)
    .sort((a, b) => a[1].date.localeCompare(b[1].date) || String(a[1].timeRange || a[1].slot || '').localeCompare(String(b[1].timeRange || b[1].slot || '')));
}

function buildFamilyGrid() {
  const g = document.getElementById('familyGrid');
  g.innerHTML = FAMILIES.map((f) => `
    <button class="picker-btn${selectedFamilies.has(f.id) ? ' selected' : ''}" onclick="toggleFamily('${f.id}')">
      <strong>${escapeHtml(f.name)}</strong>
      <span>Esdeveniment familiar</span>
    </button>
  `).join('');
}

function buildSlotGrid() {
  const g = document.getElementById('slotGrid');
  if (!g) return;
  g.innerHTML = SLOTS.map((s) => `
    <button class="picker-btn" onclick="selectSlot('${s.id}')">
      <strong>${escapeHtml(s.name)}</strong>
      <span>${escapeHtml(s.note)}</span>
    </button>
  `).join('');
}

function buildSpaceGrid() {
  const g = document.getElementById('spaceGrid');
  g.innerHTML = SPACES.map((s) => `
    <button class="picker-btn${selectedSpaces.has(s.id) ? ' selected' : ''}" onclick="toggleSpace('${s.id}')">
      <strong>${escapeHtml(s.name)}</strong>
      <span>${escapeHtml(s.note)}</span>
    </button>
  `).join('');
}

function buildLegend() {
  document.getElementById('legendFamilies').innerHTML = FAMILIES.map((f) => `<span class="pill">${escapeHtml(f.name)}</span>`).join('');
  document.getElementById('legendSpaces').innerHTML = [
    ...SPACES.map((s) => `<span class="pill">${escapeHtml(s.name)}</span>`),
    '<span class="pill">Barbacoa + Piscina</span>'
  ].join('');
}

function toggleFamily(id) {
  if (selectedFamilies.has(id)) selectedFamilies.delete(id);
  else selectedFamilies.add(id);
  buildFamilyGrid();
}
function selectSlot(id) { buildSlotGrid(); }
function toggleSpace(id) {
  if (selectedSpaces.has(id)) selectedSpaces.delete(id);
  else selectedSpaces.add(id);
  buildSpaceGrid();
}

function resetModal() {
  editingId = null;
  selectedFamilies = new Set();
  selectedSpaces = new Set();
  document.getElementById('modalTitle').textContent = 'Nou esdeveniment';
  document.getElementById('inputTitle').value = '';
  document.getElementById('inputDate').value = dateKey(today);
  document.getElementById('inputTimeRange').value = '';
  document.getElementById('inputAdults').value = '';
  document.getElementById('inputChildren').value = '';
  document.getElementById('deleteButton').style.display = 'none';
}

function openModal(dateStr, slotId, resId) {
  resetModal();
  if (resId) {
    const r = reservations[resId];
    if (!r) return;
    editingId = resId;
    selectedFamilies = new Set(Array.isArray(r.family) ? r.family : [r.family]);
    selectedSpaces = new Set(r.spaces || []);
    document.getElementById('inputTitle').value = getEventTitle(r);
    document.getElementById('inputDate').value = r.date;
    document.getElementById('inputTimeRange').value = r.timeRange || '';
    document.getElementById('inputAdults').value = r.adults;
    document.getElementById('inputChildren').value = r.children;
    document.getElementById('modalTitle').textContent = 'Editar esdeveniment';
    document.getElementById('deleteButton').style.display = 'inline-flex';
  } else {
    document.getElementById('inputDate').value = dateStr || dateKey(today);
  }
  document.getElementById('whatsappButton').style.display = 'inline-flex';
  buildFamilyGrid();
  buildSpaceGrid();
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

async function handleDelete() {
  if (!editingId || !reservations[editingId]) return;
  if (!confirm('Vols eliminar aquest esdeveniment?')) return;
  const id = editingId;
  const r = reservations[id];
  const googleEventId = r && r.googleEventId;
  closeModal();
  delete reservations[id];
  renderAll();
  try { await db.ref('reservations/' + id).remove(); } catch (e) { console.warn(e); }
  if (googleEventId) await syncCalendar('delete', r, googleEventId);
  showNotif('Esdeveniment eliminat', 'success');
}

async function saveReservation() {
  const title = document.getElementById('inputTitle').value.trim();
  const date = document.getElementById('inputDate').value;
  const timeRange = document.getElementById('inputTimeRange').value.trim();
  const adults = Number(document.getElementById('inputAdults').value || 0);
  const children = Number(document.getElementById('inputChildren').value || 0);

  if (!title) { showNotif('Indica un títol per a l\'esdeveniment', 'error'); return; }
  if (!date) { showNotif('Selecciona una data', 'error'); return; }
  if (!selectedFamilies.size) { showNotif('Selecciona qui crea l\'esdeveniment', 'error'); return; }
  if (!selectedSpaces.size) { showNotif('Selecciona almenys un espai', 'error'); return; }
  if (Number.isNaN(adults) || Number.isNaN(children) || adults < 0 || children < 0) { showNotif('Revisa els valors', 'error'); return; }

  const total = adults + children;
  if (total <= 0) { showNotif('Indica com a mínim una persona', 'error'); return; }

  const reservation = {
    title, date, timeRange, family: Array.from(selectedFamilies),
    spaces: Array.from(selectedSpaces), adults, children,
    totalPeople: total, capacityColor: getCapColor(total),
    createdAt: editingId && reservations[editingId] ? reservations[editingId].createdAt : Date.now()
  };

  const id = editingId || `rtdb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Guardem l'estat d'edició ABANS de tancar el modal (editingId es perd al closeModal)
  const isEdit = !!editingId;
  const notifText = isEdit ? 'Esdeveniment actualitzat' : 'Esdeveniment desat';

  // Recuperem el googleEventId des de Firebase directament (font de veritat)
  let existingGcalId = null;
  if (isEdit) {
    try {
      const snap = await db.ref('reservations/' + id + '/googleEventId').once('value');
      existingGcalId = snap.val() || null;
    } catch (e) { existingGcalId = (reservations[id] && reservations[id].googleEventId) || null; }
  }
  if (existingGcalId) reservation.googleEventId = existingGcalId;

  // Afegim firebaseId perquè la Cloud Function pugui desar el googleEventId
  reservation.firebaseId = id;

  closeModal();
  showView('summary');

  reservations[id] = reservation;
  renderAll();

  try { await db.ref('reservations/' + id).set(reservation); } catch (e) { console.warn('RTDB save failed:', e); updateSyncStatus(false); }

  // Sincronitza amb Google Calendar
  const gcalAction = (isEdit && existingGcalId) ? 'update' : 'create';
  const newGoogleEventId = await syncCalendar(gcalAction, reservation, existingGcalId);
  if (newGoogleEventId) {
    reservation.googleEventId = newGoogleEventId;
    reservations[id] = reservation;
    try { await db.ref('reservations/' + id + '/googleEventId').set(newGoogleEventId); } catch (e) {}
  }

  showNotif(notifText + (newGoogleEventId ? ' 📅' : ''), 'success');
}

function resCardHTML(id, r, compact) {
  const fn = Array.isArray(r.family) ? getFamiliesLabel(r.family) : getFamilyName(r.family);
  const sl = getSpacesLabel(r.spaces);
  const total = getTotalPeople(r);
  const color = r.capacityColor || getCapColor(total);
  const ct = `${r.adults} adults · ${r.children} nens`;
  const time = getEventTimeLabel(r);

  if (compact) {
    return `<div class="chip ${color}" onclick="event.stopPropagation();openModal('','','${id}')">${escapeHtml(getFamilyInitials(r.family))}</div>`;
  }
  return `
    <button class="res-card ${color}" onclick="openModal('','','${id}')">
      <div class="res-top"><span class="res-family">${escapeHtml(getEventTitle(r))}</span><span class="res-badge">${escapeHtml(time)}</span></div>
      <div class="res-meta">${escapeHtml(fn)}</div>
      <div class="res-meta">${escapeHtml(sl)}</div>
      <div class="res-meta">${escapeHtml(ct)}</div>
      <div class="res-total">${total} persones · ${escapeHtml(getCapLabel(total))}</div>
    </button>`;
}

function getNextWeekend() {
  const start = new Date(today);
  const day = (start.getDay() + 6) % 7;
  if (day >= 5) start.setDate(start.getDate() - (day - 5));
  else start.setDate(start.getDate() + (5 - day));
  const dates = [new Date(start)];
  if (start.getDay() !== 0) {
    const d = new Date(start);
    d.setDate(start.getDate() + 1);
    dates.push(d);
  }
  return dates;
}

function renderEventSummary() {
  const items = getUpcomingReservations();
  const html = items.length
    ? items.map(([id, r]) => {
        const total = getTotalPeople(r);
        const color = r.capacityColor || getCapColor(total);
        const date = parseDate(r.date);
        return `<article class="event-card ${color}" onclick="openModal('','','${id}')">
          <div class="event-date"><span>${date.getDate()}</span><strong>${MONTHS_CA[date.getMonth()].slice(0, 3)}</strong></div>
          <div class="event-main">
            <div class="event-title">${escapeHtml(getEventTitle(r))}</div>
            <div class="event-meta">${escapeHtml(formatDateLabel(date))}${r.timeRange ? ` · ${escapeHtml(r.timeRange)}` : ''}</div>
            <div class="event-meta">${escapeHtml(Array.isArray(r.family) ? getFamiliesLabel(r.family) : getFamilyName(r.family))} · ${escapeHtml(getSpacesLabel(r.spaces))}</div>
            <div class="event-total">${total} persones · ${escapeHtml(getCapLabel(total))}</div>
          </div>
        </article>`;
      }).join('')
    : '<div class="weekend-empty">No hi ha esdeveniments programats.</div>';
  document.getElementById('eventSummary').innerHTML = html;
}

function renderWeekMobile(dates) {
  const html = dates.map((date) => {
    const key = dateKey(date);
    const dayRes = getReservationsForDate(key);
    const blocks = SLOTS.map((slot) => {
      const entry = dayRes.find(([, r]) => r.slot === slot.id);
      const content = entry
        ? resCardHTML(entry[0], entry[1])
        : `<div class="mobile-empty">Franja lliure</div><button class="btn-soft" onclick="openModal('${key}','${slot.id}')">Reservar ${escapeHtml(slot.name.toLowerCase())}</button>`;
      return `<div class="mobile-slot"><div class="ms-head"><div class="ms-title">${escapeHtml(slot.name)}</div><div class="ms-note">${escapeHtml(slot.note)}</div></div>${content}</div>`;
    }).join('');
    const wc = isWeekend(date) ? ' weekend' : '';
    const tc = isToday(date) ? ' today' : '';
    return `<section class="mobile-day${wc}${tc}"><div class="md-head"><div><div class="md-name">${escapeHtml(DAY_NAMES[(date.getDay()+6)%7])}</div><div class="md-date">${date.getDate()} ${MONTHS_CA[date.getMonth()]} ${date.getFullYear()}</div></div><span class="md-badge">${dayRes.length} ${dayRes.length===1?'reserva':'reserves'}</span></div><div class="ms-list">${blocks}</div></section>`;
  }).join('');
  document.getElementById('weekMobile').innerHTML = '<div class="wm-list">' + html + '</div>';
}

function renderWeek() {
  const dates = getWeekDates(weekOffset);
  const from = dates[0], to = dates[6];
  document.getElementById('weekTitle').textContent = from.getMonth() === to.getMonth()
    ? `${from.getDate()}-${to.getDate()} ${MONTHS_CA[from.getMonth()]} ${from.getFullYear()}`
    : `${from.getDate()} ${MONTHS_CA[from.getMonth()]} - ${to.getDate()} ${MONTHS_CA[to.getMonth()]} ${to.getFullYear()}`;
  renderEventSummary();

  let html = '<div class="wc-corner"></div>';
  dates.forEach((date) => {
    const mi = (date.getDay() + 6) % 7;
    const we = isWeekend(date) ? ' weekend' : '';
    const td = isToday(date) ? ' today' : '';
    html += `<div class="wc-header${we}${td}">${DAY_SHORT[mi]}<strong>${date.getDate()}</strong></div>`;
  });

  SLOTS.forEach((slot) => {
    html += `<div class="wc-slot"><div class="wcs-name">${escapeHtml(slot.name)}</div><div class="wcs-note">${escapeHtml(slot.note)}</div></div>`;
    dates.forEach((date) => {
      const key = dateKey(date);
      const entry = getReservationFor(key, slot.id);
      const we = isWeekend(date) ? ' weekend' : '';
      if (entry) {
        html += `<div class="wc-cell${we}">${resCardHTML(entry[0], entry[1])}</div>`;
      } else {
        html += `<div class="wc-cell${we}"><div class="cell-empty"><span class="empty-note">Franja lliure</span><button class="btn-soft" onclick="openModal('${key}','${slot.id}')">Reservar ${escapeHtml(slot.name.toLowerCase())}</button></div></div>`;
      }
    });
  });

  document.getElementById('weekGrid').innerHTML = html;
  renderWeekMobile(dates);
}

function renderMonthCalendar() {
  const first = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
  document.getElementById('monthTitle').textContent = `${MONTHS_CA[first.getMonth()]} ${first.getFullYear()}`;

  let html = DAY_SHORT.map((d) => `<div class="mc-header">${d}</div>`).join('');

  const fwd = (first.getDay() + 6) % 7;
  const dim = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const dimPrev = new Date(first.getFullYear(), first.getMonth(), 0).getDate();
  const cells = [];

  for (let i = fwd - 1; i >= 0; i--) cells.push({ date: new Date(first.getFullYear(), first.getMonth() - 1, dimPrev - i), other: true });
  for (let d = 1; d <= dim; d++) cells.push({ date: new Date(first.getFullYear(), first.getMonth(), d), other: false });
  while (cells.length < 42) {
    const next = cells.length - fwd - dim + 1;
    cells.push({ date: new Date(first.getFullYear(), first.getMonth() + 1, next), other: true });
  }

  cells.forEach(({ date, other }) => {
    const key = dateKey(date);
    const dayRes = getReservationsForDate(key);
    const chips = dayRes.length
      ? dayRes.map(([id, r]) => `<div class="chip ${r.capacityColor||getCapColor(getTotalPeople(r))}" onclick="event.stopPropagation();openModal('','','${id}')">${escapeHtml(getFamilyInitials(r.family))}</div>`).join('')
      : '';
    const ot = other ? ' other' : '';
    const we = isWeekend(date) ? ' weekend' : '';
    const td = isToday(date) ? ' today' : '';
    html += `<div class="mc-day${ot}${we}${td}" onclick="openDayDetail('${key}')"><div class="mc-day-top"><span class="mc-day-num">${date.getDate()}</span></div><div class="mc-day-items">${chips||'<span class="mc-empty">-</span>'}</div></div>`;
  });

  document.getElementById('monthGrid').innerHTML = html;
}

function getDayDetailCardHTML(id, r) {
  const total = getTotalPeople(r);
  const color = r.capacityColor || getCapColor(total);
  return `<div class="day-item ${color}"><div class="di-top"><div><div class="di-title">${escapeHtml(getEventTitle(r))}</div><div class="di-sub">${escapeHtml(Array.isArray(r.family) ? getFamiliesLabel(r.family) : getFamilyName(r.family))} · ${escapeHtml(getEventTimeLabel(r))}</div><div class="di-sub">${escapeHtml(getSpacesLabel(r.spaces))}</div></div><div class="di-actions"><button class="btn-soft" onclick="closeDayDetail();openModal('','','${id}')">Editar</button></div></div><div class="di-sub">${r.adults} adults · ${r.children} nens</div><div class="di-total">${total} persones · ${escapeHtml(getCapLabel(total))}</div></div>`;
}

function openDayDetail(dateStr) {
  activeDay = dateStr;
  const date = parseDate(dateStr);
  const items = getReservationsForDate(dateStr);
  document.getElementById('dayDetailTitle').textContent = formatDateLabel(date);
  document.getElementById('dayDetailBody').innerHTML = items.length
    ? '<div class="dd-list">' + items.map(([id, r]) => getDayDetailCardHTML(id, r)).join('') + '</div>'
    : '<div class="dd-empty">No hi ha esdeveniments per aquest dia.</div>';
  document.getElementById('dayDetailAddEvent').onclick = () => { closeDayDetail(); openModal(dateStr); };
  document.getElementById('dayDetailOverlay').classList.add('open');
}

function closeDayDetail() { document.getElementById('dayDetailOverlay').classList.remove('open'); }

function renderAll() {
  renderEventSummary();
  renderMonthCalendar();
  buildLegend();
  if (currentView === 'historic') renderHistoric();
  showView(currentView);
}

function updateSyncStatus(connected) {
  const dot = document.querySelector('.sync-dot');
  const txt = document.getElementById('syncStatus');
  if (dot && txt) {
    dot.style.background = connected ? '#22c55e' : '#eab308';
    txt.textContent = connected ? 'Connectat' : 'Mode local';
  }
}

function startRealtimeSync() {
  try {
    reservationsRef.on('value', (snapshot) => {
      rtdbReady = true;
      const val = snapshot.val();
      reservations = val || {};
      renderAll();
      updateSyncStatus(true);
    }, (err) => {
      console.warn('RTDB error:', err);
      rtdbReady = false;
      updateSyncStatus(false);
    });

    feedbackRef.on('value', (snapshot) => {
      feedbacks = snapshot.val() || {};
      if (feedbackTab === 'list') renderFeedbackList();
    });

    setTimeout(() => {
      if (!rtdbReady) updateSyncStatus(false);
    }, 8000);
  } catch (err) {
    console.warn('RTDB init error:', err);
  }
}

/* ===== HISTORIC VIEW ===== */

function getAllReservationsSorted() {
  return Object.entries(reservations)
    .sort((a, b) => b[1].date.localeCompare(a[1].date));
}

function getFilteredReservations() {
  const { family, space, dateFrom, dateTo } = historicFilter;
  return getAllReservationsSorted().filter(([, r]) => {
    if (family && !(Array.isArray(r.family) ? r.family.includes(family) : r.family === family)) return false;
    if (space && !(r.spaces || []).includes(space)) return false;
    if (dateFrom && r.date < dateFrom) return false;
    if (dateTo && r.date > dateTo) return false;
    return true;
  });
}

function computeStats(entries) {
  const byFamily = {}, bySpace = {}, byMonth = {};
  let totalAdults = 0, totalChildren = 0;

  entries.forEach(([, r]) => {
    const adults = Number(r.adults || 0);
    const children = Number(r.children || 0);
    totalAdults += adults;
    totalChildren += children;

    const families = Array.isArray(r.family) ? r.family : [r.family];
    families.forEach(fid => {
      if (!byFamily[fid]) byFamily[fid] = { events: 0, adults: 0, children: 0 };
      byFamily[fid].events++;
      byFamily[fid].adults += adults;
      byFamily[fid].children += children;
    });

    (r.spaces || []).forEach(sid => {
      if (!bySpace[sid]) bySpace[sid] = 0;
      bySpace[sid]++;
    });

    const month = r.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { events: 0, people: 0 };
    byMonth[month].events++;
    byMonth[month].people += adults + children;
  });

  return { byFamily, bySpace, byMonth, totalAdults, totalChildren };
}

function destroyCharts() {
  Object.values(_chartInstances).forEach(c => { try { c.destroy(); } catch(e) {} });
  _chartInstances = {};
}

function renderChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (_chartInstances[canvasId]) { try { _chartInstances[canvasId].destroy(); } catch(e) {} }
  _chartInstances[canvasId] = new Chart(canvas.getContext('2d'), config);
}

function renderHistoric() {
  const entries = getFilteredReservations();
  const stats = computeStats(entries);
  renderHistoricFilters();
  renderKPIs(stats, entries.length);
  renderChartsSection(stats);
  renderHistoricTable(entries);
}

function renderHistoricFilters() {
  const el = document.getElementById('historicFilters');
  if (!el) return;
  const { family, space, dateFrom, dateTo } = historicFilter;

  el.innerHTML = `
    <div class="hf-grid">
      <div class="form-group hf-group">
        <label class="form-label">Família</label>
        <select class="form-control form-control-sm" onchange="historicFilter.family=this.value;renderHistoric()">
          <option value="">Totes</option>
          ${FAMILIES.map(f => `<option value="${f.id}"${family===f.id?' selected':''}>${escapeHtml(f.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group hf-group">
        <label class="form-label">Espai</label>
        <select class="form-control form-control-sm" onchange="historicFilter.space=this.value;renderHistoric()">
          <option value="">Tots</option>
          ${SPACES.map(s => `<option value="${s.id}"${space===s.id?' selected':''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group hf-group">
        <label class="form-label">Des de</label>
        <input type="date" class="form-control form-control-sm" value="${dateFrom}" onchange="historicFilter.dateFrom=this.value;renderHistoric()">
      </div>
      <div class="form-group hf-group">
        <label class="form-label">Fins a</label>
        <input type="date" class="form-control form-control-sm" value="${dateTo}" onchange="historicFilter.dateTo=this.value;renderHistoric()">
      </div>
      <div class="form-group hf-group hf-reset">
        <label class="form-label">&nbsp;</label>
        <button class="btn-secondary" onclick="historicFilter={family:'',space:'',dateFrom:'',dateTo:''};renderHistoric()">Netejar</button>
      </div>
    </div>`;
}

function renderKPIs(stats, count) {
  const el = document.getElementById('historicKPIs');
  if (!el) return;
  const total = stats.totalAdults + stats.totalChildren;
  const avg = count > 0 ? (total / count).toFixed(1) : 0;
  const topFamily = Object.entries(stats.byFamily).sort((a,b) => b[1].events - a[1].events)[0];
  const topSpace = Object.entries(stats.bySpace).sort((a,b) => b[1] - a[1])[0];

  el.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card blue">
        <div class="kpi-num">${count}</div>
        <div class="kpi-label">Esdeveniments</div>
      </div>
      <div class="kpi-card yellow">
        <div class="kpi-num">${stats.totalAdults}</div>
        <div class="kpi-label">Adults totals</div>
      </div>
      <div class="kpi-card red">
        <div class="kpi-num">${stats.totalChildren}</div>
        <div class="kpi-label">Nens totals</div>
      </div>
      <div class="kpi-card purple">
        <div class="kpi-num">${total}</div>
        <div class="kpi-label">Persones totals</div>
      </div>
      <div class="kpi-card green">
        <div class="kpi-num">${avg}</div>
        <div class="kpi-label">Mitjana / event</div>
      </div>
      <div class="kpi-card teal">
        <div class="kpi-num">${topFamily ? escapeHtml(getFamilyName(topFamily[0]).split('/')[0].trim()) : '—'}</div>
        <div class="kpi-label">Família + activa</div>
      </div>
    </div>`;
}

function renderChartsSection(stats) {
  destroyCharts();
  const isDark = document.documentElement.dataset.theme === 'dark';
  const textColor = isDark ? '#b4c0d3' : '#55657a';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';

  const COLORS = ['#2563eb','#b45309','#dc2626','#7c3aed','#16a34a','#0891b2','#ea580c','#db2777'];
  const BG_COLORS = ['#bfdbfe','#fde68a','#fca5a5','#ddd6fe','#a7f3d0','#a5f3fc','#fed7aa','#fbcfe8'];

  const baseScales = {
    x: { ticks: { color: textColor, font: { family: 'Inter', size: 11 } }, grid: { color: gridColor } },
    y: { ticks: { color: textColor, font: { family: 'Inter', size: 11 } }, grid: { color: gridColor }, beginAtZero: true }
  };
  const baseLegend = { labels: { color: textColor, font: { family: 'Inter', size: 11 }, padding: 10, boxWidth: 11, boxHeight: 11 } };

  // Chart 1: pie/donut of events by family with total count in center
  const famEntries = Object.entries(stats.byFamily).sort((a,b) => b[1].events - a[1].events);
  const totalEvents = famEntries.reduce((s,[,v]) => s + v.events, 0);
  const centerFam = document.getElementById('chartFamilyPieCenter');
  if (centerFam) { centerFam.innerHTML = `<span class="donut-num">${totalEvents}</span><span class="donut-label">events</span>`; }
  if (famEntries.length) {
    renderChart('chartFamilyPie', {
      type: 'doughnut',
      data: {
        labels: famEntries.map(([id]) => getFamilyName(id)),
        datasets: [{
          data: famEntries.map(([,v]) => v.events),
          backgroundColor: BG_COLORS.slice(0, famEntries.length),
          borderColor: COLORS.slice(0, famEntries.length),
          borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { ...baseLegend.labels,
              generateLabels: (chart) => chart.data.labels.map((label, i) => ({
                text: `${label}: ${chart.data.datasets[0].data[i]}`,
                fillStyle: chart.data.datasets[0].backgroundColor[i],
                strokeStyle: chart.data.datasets[0].borderColor[i],
                lineWidth: 1.5, hidden: false, index: i
              }))
            }
          },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed} event${ctx.parsed !== 1 ? 's' : ''}` } }
        }
      }
    });
  }

  // Chart 2: timeline by month (line, dual axis)
  const monthEntries = Object.entries(stats.byMonth).sort((a,b) => a[0].localeCompare(b[0]));
  if (monthEntries.length) {
    const monthLabels = monthEntries.map(([m]) => {
      const [y, mo] = m.split('-');
      return `${MONTHS_CA[Number(mo)-1].slice(0,3)} ${y.slice(2)}`;
    });
    renderChart('chartByMonth', {
      type: 'line',
      data: {
        labels: monthLabels,
        datasets: [
          { label: 'Esdeveniments', data: monthEntries.map(([,v]) => v.events), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.1)', fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: '#2563eb' },
          { label: 'Persones', data: monthEntries.map(([,v]) => v.people), borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.08)', fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: '#16a34a', yAxisID: 'y2' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { ...baseLegend, position: 'top' } },
        scales: {
          x: baseScales.x,
          y: { ...baseScales.y, title: { display: true, text: 'Events', color: textColor, font: { size: 11 } } },
          y2: { ticks: { color: textColor }, grid: { display: false }, beginAtZero: true, position: 'right', title: { display: true, text: 'Persones', color: textColor, font: { size: 11 } } }
        }
      }
    });
  }

  // Chart 3: spaces donut with total in center
  const spaceEntries = SPACES.map(s => [s.id, stats.bySpace[s.id] || 0]).filter(([,v]) => v > 0);
  const totalSpaceUses = spaceEntries.reduce((s,[,v]) => s + v, 0);
  const centerSpace = document.getElementById('chartBySpaceCenter');
  if (centerSpace) { centerSpace.innerHTML = `<span class="donut-num">${totalSpaceUses}</span><span class="donut-label">usos</span>`; }
  if (spaceEntries.length) {
    renderChart('chartBySpace', {
      type: 'doughnut',
      data: {
        labels: spaceEntries.map(([id]) => getSpaceName(id)),
        datasets: [{ data: spaceEntries.map(([,v]) => v), backgroundColor: BG_COLORS.slice(0, spaceEntries.length), borderColor: COLORS.slice(0, spaceEntries.length), borderWidth: 2 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { ...baseLegend.labels,
              generateLabels: (chart) => chart.data.labels.map((label, i) => ({
                text: `${label}: ${chart.data.datasets[0].data[i]}`,
                fillStyle: chart.data.datasets[0].backgroundColor[i],
                strokeStyle: chart.data.datasets[0].borderColor[i],
                lineWidth: 1.5, hidden: false, index: i
              }))
            }
          },
          tooltip: { callbacks: { label: (ctx) => { const pct = ((ctx.parsed/totalSpaceUses)*100).toFixed(0); return ` ${ctx.label}: ${ctx.parsed} (${pct}%)`; } } }
        }
      }
    });
  }
}


function renderHistoricTable(entries) {
  const el = document.getElementById('historicTable');
  if (!el) return;

  if (!entries.length) {
    el.innerHTML = '<div class="dd-empty">No hi ha esdeveniments amb els filtres aplicats.</div>';
    return;
  }

  const sortedEntries = [...entries].sort((a, b) => {
    const { col, dir } = historicSort;
    let va, vb;
    if (col === 'date') { va = a[1].date; vb = b[1].date; }
    else if (col === 'title') { va = getEventTitle(a[1]); vb = getEventTitle(b[1]); }
    else if (col === 'family') { va = getFamiliesLabel(Array.isArray(a[1].family)?a[1].family:[a[1].family]); vb = getFamiliesLabel(Array.isArray(b[1].family)?b[1].family:[b[1].family]); }
    else if (col === 'people') { va = getTotalPeople(a[1]); vb = getTotalPeople(b[1]); }
    else { va = ''; vb = ''; }
    if (typeof va === 'number') return dir === 'asc' ? va - vb : vb - va;
    return dir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
  });

  function sortIcon(col) {
    if (historicSort.col !== col) return '<span class="sort-icon">↕</span>';
    return historicSort.dir === 'asc' ? '<span class="sort-icon active">↑</span>' : '<span class="sort-icon active">↓</span>';
  }

  const rows = sortedEntries.map(([id, r]) => {
    const total = getTotalPeople(r);
    const color = r.capacityColor || getCapColor(total);
    const date = parseDate(r.date);
    const isPast = r.date < dateKey(today);
    const isFuture = r.date > dateKey(today);
    return `<tr class="ht-row${isPast?' ht-past':''}" onclick="openModal('','','${id}')">
      <td>
        <span class="ht-date">${date.getDate()} ${MONTHS_CA[date.getMonth()].slice(0,3)} ${date.getFullYear()}</span>
        ${isPast ? '<span class="ht-tag past">Passat</span>' : isFuture ? '<span class="ht-tag future">Pròxim</span>' : '<span class="ht-tag today-tag">Avui</span>'}
      </td>
      <td><span class="ht-title">${escapeHtml(getEventTitle(r))}</span></td>
      <td class="ht-family">${escapeHtml(Array.isArray(r.family)?getFamiliesLabel(r.family):getFamilyName(r.family))}</td>
      <td class="ht-spaces">${escapeHtml(getSpacesLabel(r.spaces))}</td>
      <td><span class="cap-dot ${color}"></span><span class="ht-people">${r.adults}a · ${r.children}n = <strong>${total}</strong></span></td>
    </tr>`;
  }).join('');

  el.innerHTML = `
    <div class="ht-scroll">
      <table class="ht-table">
        <thead>
          <tr>
            <th class="sortable" onclick="historicSort.col==='date'?(historicSort.dir=historicSort.dir==='asc'?'desc':'asc'):(historicSort.col='date',historicSort.dir='asc');renderHistoricTable(getFilteredReservations())">Data ${sortIcon('date')}</th>
            <th class="sortable" onclick="historicSort.col==='title'?(historicSort.dir=historicSort.dir==='asc'?'desc':'asc'):(historicSort.col='title',historicSort.dir='asc');renderHistoricTable(getFilteredReservations())">Títol ${sortIcon('title')}</th>
            <th class="sortable" onclick="historicSort.col==='family'?(historicSort.dir=historicSort.dir==='asc'?'desc':'asc'):(historicSort.col='family',historicSort.dir='asc');renderHistoricTable(getFilteredReservations())">Família ${sortIcon('family')}</th>
            <th>Espais</th>
            <th class="sortable" onclick="historicSort.col==='people'?(historicSort.dir=historicSort.dir==='asc'?'desc':'asc'):(historicSort.col='people',historicSort.dir='asc');renderHistoricTable(getFilteredReservations())">Persones ${sortIcon('people')}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/* ===== FEEDBACK ===== */

function showInfo() { document.getElementById('infoOverlay').classList.add('open'); }
function closeInfo() { document.getElementById('infoOverlay').classList.remove('open'); }

function showFeedback() {
  feedbackTab = 'submit';
  document.getElementById('feedbackOverlay').classList.add('open');
  renderFeedbackSubmit();
}

function closeFeedback() { document.getElementById('feedbackOverlay').classList.remove('open'); }

function switchFeedback(tab) {
  feedbackTab = tab;
  document.getElementById('fbTabSubmit').classList.toggle('active', tab === 'submit');
  document.getElementById('fbTabList').classList.toggle('active', tab === 'list');
  if (tab === 'submit') renderFeedbackSubmit();
  else renderFeedbackList();
}

function renderFeedbackSubmit() {
  document.getElementById('feedbackBody').innerHTML = `
    <div class="fb-form">
      <div class="form-group">
        <label class="form-label">Tipus</label>
        <div class="picker-grid" id="fbTypeGrid"></div>
      </div>
      <div class="form-group">
        <label class="form-label" for="fbText">Descripció</label>
        <textarea class="form-control fb-textarea" id="fbText" rows="4" placeholder="Explica la teva proposta..."></textarea>
      </div>
      <button class="btn-primary" onclick="submitFeedback()">Enviar proposta</button>
    </div>`;
  const grid = document.getElementById('fbTypeGrid');
  const types = [
    { id: 'correccio', name: 'Correcció', note: 'Error o millora' },
    { id: 'evolutiu', name: 'Evolutiu', note: 'Nova funcionalitat' }
  ];
  window.__fbType = 'correccio';
  grid.innerHTML = types.map((t) =>
    `<button class="picker-btn${t.id === 'correccio' ? ' selected' : ''}" onclick="window.__fbType='${t.id}';document.querySelectorAll('#fbTypeGrid .picker-btn').forEach(b=>b.classList.remove('selected'));this.classList.add('selected')"><strong>${t.name}</strong><span>${t.note}</span></button>`
  ).join('');
}

async function submitFeedback() {
  const text = document.getElementById('fbText').value.trim();
  if (!text) { showNotif('Escriu una descripció', 'error'); return; }
  try {
    await feedbackRef.push().set({ text, type: window.__fbType || 'correccio', status: 'pending', createdAt: Date.now() });
    showNotif('Proposta enviada', 'success');
    document.getElementById('fbText').value = '';
  } catch (e) {
    showNotif('Error en enviar', 'error');
    console.warn(e);
  }
}

function renderFeedbackList() {
  const entries = Object.entries(feedbacks).sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));
  const html = entries.length
    ? entries.map(([id, fb]) => {
        const statusLabel = { pending: 'Pendent', approved: 'Aprovada', applied: 'Aplicada' }[fb.status] || fb.status;
        const statusClass = fb.status || 'pending';
        const typeLabel = fb.type === 'evolutiu' ? 'Evolutiu' : 'Correcció';
        return `<div class="fb-item ${statusClass}">
          <div class="fb-item-top">
            <span class="fb-type">${typeLabel}</span>
            <span class="fb-status ${statusClass}">${statusLabel}</span>
          </div>
          <div class="fb-text">${escapeHtml(fb.text)}</div>
          <div class="fb-actions">
            ${fb.status !== 'approved' ? `<button class="btn-tiny green" onclick="updateFeedbackStatus('${id}','approved')">Aprovar</button>` : ''}
            ${fb.status !== 'applied' ? `<button class="btn-tiny blue" onclick="updateFeedbackStatus('${id}','applied')">Aplicada</button>` : ''}
            ${fb.status !== 'pending' ? `<button class="btn-tiny gray" onclick="updateFeedbackStatus('${id}','pending')">Pendent</button>` : ''}
          </div>
        </div>`;
      }).join('')
    : '<div class="fb-empty">No hi ha propostes encara.</div>';
  document.getElementById('feedbackBody').innerHTML = `<div class="fb-list">${html}</div>`;
}

async function updateFeedbackStatus(id, status) {
  try {
    await db.ref('feedback/' + id + '/status').set(status);
  } catch (e) { console.warn(e); }
}

/* ===== THEME + INSTALL PROMPT ===== */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
}

function initTheme() {
  const saved = localStorage.getItem('appmoltures-theme') || 'light';
  applyTheme(saved);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('appmoltures-theme', next);
  applyTheme(next);
  // Re-render charts with new theme colors
  if (currentView === 'historic') renderHistoric();
}

function initInstallPrompt() {
  if (localStorage.getItem('appmoltures-hide-install') === '1') return;
  setTimeout(() => document.getElementById('installOverlay').classList.add('open'), 700);
}

function closeInstallPrompt() {
  if (document.getElementById('dontShowInstall').checked) {
    localStorage.setItem('appmoltures-hide-install', '1');
  }
  document.getElementById('installOverlay').classList.remove('open');
}

/* ===== SCROLL HIDE/SHOW (header + bottom nav persiana) ===== */
function initScrollBehavior() {
  const header = document.querySelector('header');
  const bottomNav = document.getElementById('bottom-nav');
  if (!header && !bottomNav) return;

  let lastY = window.scrollY;
  let ticking = false;
  const THRESHOLD = 6;

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      const delta = y - lastY;

      if (Math.abs(delta) > THRESHOLD) {
        const goingDown = delta > 0;
        if (header) header.style.transform = goingDown ? 'translateY(-100%)' : 'translateY(0)';
        if (bottomNav) bottomNav.style.transform = goingDown ? 'translateY(100%)' : 'translateY(0)';
        lastY = y;
      }

      if (y <= 10) {
        if (header) header.style.transform = 'translateY(0)';
        if (bottomNav) bottomNav.style.transform = 'translateY(0)';
        lastY = y;
      }

      ticking = false;
    });
  }, { passive: true });
}

/* ===== INIT ===== */

initTheme();
renderAll();
showView('summary');
startRealtimeSync();
initInstallPrompt();
initScrollBehavior();
