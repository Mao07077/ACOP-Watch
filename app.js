const labels = { 'for-acop': 'For ACOP', approval: 'For approval', approved: 'Approved', overdue: 'Overdue' };
let clients = [];
let activeFilter = 'all';
let activePensionType = 'all';
let age80Only = false;
let scheduleMonthOffset = null;
let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let lastNotificationSummary = null;
let currentPage = 1;
const pageSize = 25;
const table = document.querySelector('#clientTable');
const emptyState = document.querySelector('#emptyState');
const toast = document.querySelector('#toast');
const clientDialog = document.querySelector('#clientDialog');
const clientForm = document.querySelector('#clientForm');
const detailsDialog = document.querySelector('#detailsDialog');
const calendarDayDialog = document.querySelector('#calendarDayDialog');
const proofDialog = document.querySelector('#proofDialog');
const proofForm = document.querySelector('#proofForm');
const proofUrlInput = document.querySelector('#proofUrl');
const proofConfirmation = document.querySelector('#proofConfirmation');
const proofError = document.querySelector('#proofError');
const confirmDialog = document.querySelector('#confirmDialog');
const confirmForm = document.querySelector('#confirmForm');
let editingClientId = null;
let proofDialogClient = null;
let currentUser = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function userInitials(user) {
  return String(user?.displayName || user?.username || 'AW').trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function applyCurrentUser(user) {
  currentUser = user;
  const name = user.displayName || user.username;
  const role = user.role === 'admin' ? 'Administrator' : 'Branch user';
  const initials = userInitials(user);
  document.querySelector('#sidebarUserInitials').textContent = initials;
  document.querySelector('#sidebarUserName').textContent = name;
  document.querySelector('#sidebarUserRole').textContent = role;
  document.querySelector('#profileInitials').textContent = initials;
  document.querySelector('#profileName').textContent = name;
  document.querySelector('#greetingName').textContent = `${name}.`;
}

function repairText(value) {
  return String(value ?? '')
    .replaceAll('Ã‘', 'Ñ')
    .replaceAll('Ã±', 'ñ')
    .replaceAll('Ã‰', 'É')
    .replaceAll('Ã©', 'é')
    .replaceAll('Ã“', 'Ó')
    .replaceAll('Ã³', 'ó')
    .replaceAll('Ãš', 'Ú')
    .replaceAll('Ãº', 'ú');
}

function displayContact(value) {
  const text = repairText(value).trim();
  if (!/[eE][+-]?\d+$/.test(text)) return text;
  const number = Number(text);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 }) : text;
}

function displayIdentifier(value) {
  const text = repairText(value).trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  let normalized = text;
  if (match) {
    const sign = match[1] === '-' ? '-' : '';
    const digits = `${match[2]}${match[3] || ''}`;
    const decimalPosition = match[2].length + Number(match[4]);
    if (decimalPosition <= 0) normalized = `${sign}0.${'0'.repeat(Math.abs(decimalPosition))}${digits}`;
    else if (decimalPosition >= digits.length) normalized = `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
    else normalized = `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`.replace(/\.$/, '');
  }
  const digitsOnly = normalized.replace(/^\+/, '').replace(/\D/g, '');
  if (!digitsOnly || digitsOnly.length < 10 || normalized.includes('.')) return normalized;
  const formatted = `${digitsOnly.slice(0, 2)}-${digitsOnly.slice(2, -1)}-${digitsOnly.slice(-1)}`;
  return normalized.startsWith('-') ? `-${formatted}` : formatted;
}

function pensionCategory(type) {
  const normalized = String(type || '').toUpperCase();
  if (normalized.includes('RT')) return 'RT';
  if (normalized.includes('ST')) return 'ST';
  if (normalized.includes('SP')) return 'SP';
  if (normalized.includes('SD')) return 'SD';
  return 'Other';
}

function isGsisPension(type) {
  return String(type || '').toUpperCase().includes('GSIS');
}

function displayName(client) {
  const source = client.sourceData || {};
  const lastName = repairText(source.LASTNAME).trim();
  const firstName = repairText(source.FIRSTNAME).trim();
  const middleName = repairText(source.MIDDLENAME).trim();
  if (lastName && firstName) return [lastName, firstName, middleName].filter(Boolean).join(', ');
  return repairText(client.name).trim();
}

function workflowLabel(client) {
  if (isOverdueClient(client)) return 'Overdue';
  if (isGsisPension(client.type) && client.status === 'for-acop') return 'ACOP / APIR';
  if (client.status === 'approved') return 'Done';
  return labels[client.status] || client.status;
}

function getAge(client) {
  const birthday = client.sourceData?.BIRTHDAY || client.date;
  if (!birthday) return null;
  const birthDate = new Date(birthday);
  if (Number.isNaN(birthDate.valueOf())) return null;
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const birthdayThisYear = new Date(today.getFullYear(), birthDate.getMonth(), birthDate.getDate());
  if (birthdayThisYear > today) age -= 1;
  return age;
}

function scheduleMatchesMonth(client, offset) {
  const scheduleDate = client.acopScheduleDate ? new Date(client.acopScheduleDate) : null;
  if (!scheduleDate || Number.isNaN(scheduleDate.valueOf())) return false;
  const target = new Date();
  target.setUTCMonth(target.getUTCMonth() + offset);
  return scheduleDate.getUTCMonth() === target.getUTCMonth();
}

function isOverdueClient(client) {
  if (client.status !== 'for-acop' || client.acopEligible === false) return false;
  const scheduleDate = client.acopScheduleDate ? new Date(client.acopScheduleDate) : null;
  if (!scheduleDate || Number.isNaN(scheduleDate.valueOf())) return false;
  return scheduleDate.getUTCMonth() < new Date().getUTCMonth();
}

async function api(path, options) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json();
  if (response.status === 401) {
    window.location.href = '/';
    throw new Error('Your session has expired. Please log in again.');
  }
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function renderClients() {
  const term = document.querySelector('#searchInput').value.toLowerCase().trim();
  const filtered = clients.filter((client) => {
    const matchesFilter = activeFilter === 'all'
      || (activeFilter === 'overdue' ? isOverdueClient(client) : client.status === activeFilter);
    const matchesPensionType = activePensionType === 'all'
      || (activePensionType === 'GSIS' ? isGsisPension(client.type) : pensionCategory(client.type) === activePensionType);
    const matchesAge = !age80Only || (getAge(client) !== null && getAge(client) >= 80);
    const matchesSearch = !term || `${displayName(client)} ${repairText(client.name)} ${displayIdentifier(client.sub)} ${displayContact(client.contact)}`.toLowerCase().includes(term);
    const eligibleForAcop = activeFilter !== 'for-acop' || client.acopEligible !== false;
    const matchesScheduleMonth = scheduleMonthOffset === null || scheduleMatchesMonth(client, scheduleMonthOffset);
    return matchesFilter && matchesPensionType && matchesAge && matchesSearch && eligibleForAcop && matchesScheduleMonth;
  });
  filtered.sort((a, b) => pensionCategory(a.type).localeCompare(pensionCategory(b.type)) || displayName(a).localeCompare(displayName(b)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  currentPage = Math.min(currentPage, totalPages);
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  table.innerHTML = visible.map((client) => `
    <tr data-id="${client._id}">
      <td data-label="Client"><div class="client-cell"><span class="client-avatar ${escapeHtml(client.tone)}">${escapeHtml(client.initials)}</span><div class="client-name"><strong>${escapeHtml(displayName(client))}</strong><span>${escapeHtml(displayIdentifier(client.sub))}</span></div></div></td>
      <td data-label="Pension"><span class="pension-tag ${escapeHtml(client.type.toLowerCase())}">${escapeHtml(client.type)}</span></td>
      <td data-label="ACOP schedule"><div class="schedule"><strong>${escapeHtml(client.acopScheduleMonth || 'No schedule')}</strong><span>${escapeHtml(client.acopScheduleReason || client.ref)}${client.acopCategory === 'RT' && !client.acopEligible ? ' · Not eligible below age 80' : ''}</span></div></td>
      <td data-label="Contact">${escapeHtml(displayContact(client.contact))}</td>
      <td data-label="Status"><span class="status ${escapeHtml(client.status)}">${escapeHtml(workflowLabel(client))}</span></td>
      <td data-label="Action" class="row-actions"><button class="row-action secondary-action" data-action="view" data-id="${client._id}">View</button><button class="row-action secondary-action" data-action="edit" data-id="${client._id}">Edit</button><button class="row-action ${client.status === 'approved' || client.status === 'overdue' ? 'archive-action' : ''}" data-action="${client.status === 'for-acop' ? 'done' : client.status === 'approval' ? 'approve' : 'archive'}" data-id="${client._id}">${client.status === 'for-acop' ? 'Done' : client.status === 'approval' ? 'Approve' : 'Archive'}</button></td>
    </tr>`).join('');
  emptyState.hidden = visible.length > 0;
  const firstResult = filtered.length ? (currentPage - 1) * pageSize + 1 : 0;
  const lastResult = Math.min(currentPage * pageSize, filtered.length);
  document.querySelector('#resultCount').textContent = `Showing ${firstResult}-${lastResult} of ${filtered.length} clients`;
  renderPagination(totalPages);
  updateCounts();
  renderCalendar();
}

function renderPagination(totalPages) {
  const pagination = document.querySelector('#pagination');
  if (totalPages <= 1) {
    pagination.hidden = true;
    pagination.innerHTML = '';
    return;
  }
  pagination.hidden = false;
  const pageButtons = Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    return `<button class="page-button ${page === currentPage ? 'active' : ''}" data-page="${page}" aria-label="Page ${page}" ${page === currentPage ? 'aria-current="page"' : ''}>${page}</button>`;
  }).join('');
  pagination.innerHTML = `<button class="page-button" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}>Previous</button>${pageButtons}<button class="page-button" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}>Next</button>`;
  pagination.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => {
    const page = Number(button.dataset.page);
    if (page >= 1 && page <= totalPages && page !== currentPage) {
      currentPage = page;
      renderClients();
    }
  }));
}

function updateCounts() {
  const count = (status) => clients.filter((client) => client.status === status).length;
  const eligible = clients.filter((client) => client.acopEligible !== false);
  const currentMonth = new Date().getUTCMonth();
  const dueThisMonth = eligible.filter((client) => {
    return client.status === 'for-acop' && scheduleMatchesMonth(client, 0);
  }).length;
  const followUp = eligible.filter((client) => {
    return client.status === 'for-acop' && scheduleMatchesMonth(client, 1);
  }).length;
  const overdueCount = clients.filter(isOverdueClient).length;
  const notificationSummary = `${dueThisMonth}:${overdueCount}`;
  const alertTitle = document.querySelector('#alertTitle');
  const alertSummary = document.querySelector('#alertSummary');
  if (dueThisMonth && overdueCount) {
    alertTitle.textContent = 'ACOP action required';
    alertSummary.textContent = `${dueThisMonth} due this month and ${overdueCount} overdue client${overdueCount === 1 ? '' : 's'} need attention.`;
  } else if (dueThisMonth) {
    alertTitle.textContent = 'ACOP reminders are due';
    alertSummary.textContent = `${dueThisMonth} client${dueThisMonth === 1 ? '' : 's'} need ACOP/APIR this month.`;
  } else if (overdueCount) {
    alertTitle.textContent = 'Overdue ACOP/APIR records';
    alertSummary.textContent = `${overdueCount} client${overdueCount === 1 ? '' : 's'} missed the scheduled ACOP/APIR month.`;
  } else {
    alertTitle.textContent = 'No pending ACOP alerts';
    alertSummary.textContent = 'There are no due or overdue ACOP/APIR records right now.';
  }
  if (lastNotificationSummary !== null && lastNotificationSummary !== notificationSummary) {
    if (dueThisMonth && overdueCount) showToast(`${dueThisMonth} due this month and ${overdueCount} overdue clients need attention.`);
    else if (dueThisMonth) showToast(`${dueThisMonth} client${dueThisMonth === 1 ? '' : 's'} need ACOP/APIR this month.`);
    else if (overdueCount) showToast(`${overdueCount} overdue client${overdueCount === 1 ? '' : 's'} need follow-up.`);
    else showToast('ACOP alerts are now clear.');
  }
  lastNotificationSummary = notificationSummary;
  sendDailyReminder(dueThisMonth, overdueCount);
  const values = {
    totalClientsCount: clients.length, dashboardClientCount: clients.length, dueCount: dueThisMonth,
    completedCount: count('approved'), overdueCount: followUp, allCount: clients.length,
    forAcopCount: eligible.filter((client) => client.status === 'for-acop').length,
    doneCount: count('approved'), filterOverdueCount: overdueCount,
    reportApprovalCount: count('approval'), reportOverdueCount: overdueCount
  };
  Object.entries(values).forEach(([id, value]) => { document.querySelector(`#${id}`).textContent = String(value).padStart(2, '0'); });
}

function sendDailyReminder(dueThisMonth, overdueCount) {
  const todayKey = new Intl.DateTimeFormat('en-CA').format(new Date());
  if (window.localStorage.getItem('acopwatch-daily-reminder') === todayKey) return;
  const message = buildReminderMessage(dueThisMonth, overdueCount);
  window.localStorage.setItem('acopwatch-daily-reminder', todayKey);
  window.setTimeout(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('ACOP Watch daily reminder', {
        body: message,
        tag: 'acopwatch-daily-reminder',
        icon: '/favicon.svg'
      });
    } else {
      showToast(`${message} Enable browser notifications above to receive this as a notification.`);
    }
  }, 450);
}

function buildReminderMessage(dueThisMonth, overdueCount) {
  if (dueThisMonth && overdueCount) return `${dueThisMonth} due this month and ${overdueCount} overdue clients need attention.`;
  if (dueThisMonth) return `${dueThisMonth} client${dueThisMonth === 1 ? '' : 's'} need ACOP/APIR this month.`;
  if (overdueCount) return `${overdueCount} overdue client${overdueCount === 1 ? '' : 's'} need follow-up.`;
  return 'No due or overdue ACOP/APIR records today.';
}

function urlBase64ToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function subscribeToPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push notifications are not supported in this browser.');
  const config = await api('/api/notifications/config');
  if (!config.publicKey) throw new Error('Push notifications are not configured on the server.');
  const registration = await navigator.serviceWorker.register('/service-worker.js');
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.publicKey) });
  await api('/api/notifications/subscribe', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
}

function renderCalendar() {
  const monthTitle = document.querySelector('#calendarMonthTitle');
  const calendar = document.querySelector('#calendarGrid');
  document.querySelector('.calendar-weekdays').innerHTML = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => `<span>${day}</span>`).join('');
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(calendarMonth);
  monthTitle.textContent = monthName;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const events = clients.filter((client) => {
    const date = client.acopScheduleDate ? new Date(client.acopScheduleDate) : null;
    return date && !Number.isNaN(date.valueOf()) && date.getUTCMonth() === month;
  });
  const byDay = new Map();
  events.forEach((client) => {
    const day = new Date(client.acopScheduleDate).getUTCDate();
    byDay.set(day, [...(byDay.get(day) || []), client]);
  });
  calendar.innerHTML = '';
  for (let blank = 0; blank < firstDay; blank += 1) calendar.insertAdjacentHTML('beforeend', '<span class="calendar-empty" aria-hidden="true"></span>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dayEvents = byDay.get(day) || [];
    const today = new Date();
    const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;
    calendar.insertAdjacentHTML('beforeend', `<button type="button" class="day ${isToday ? 'today' : ''} ${dayEvents.length ? 'has-events' : ''}" data-calendar-day="${day}" aria-label="${monthName} ${day}, ${dayEvents.length} scheduled clients"><strong>${day}</strong>${dayEvents.length ? `<span class="calendar-event-count">${dayEvents.length}</span>` : ''}</button>`);
  }
}

function openCalendarDayDialog(events, day) {
  const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(calendarMonth);
  document.querySelector('#calendarDayDialogTitle').textContent = `${monthName} ${day}`;
  document.querySelector('#calendarDayDialogSummary').textContent = `${events.length} scheduled client${events.length === 1 ? '' : 's'} for this ACOP/APIR date.`;
  document.querySelector('#calendarDayDialogItems').innerHTML = events.sort((a, b) => displayName(a).localeCompare(displayName(b))).map((client) => `
    <button type="button" class="calendar-dialog-item" data-calendar-dialog-client="${client._id}">
      <span class="calendar-dialog-avatar">${escapeHtml(client.initials || displayName(client).slice(0, 2).toUpperCase())}</span>
      <span><strong>${escapeHtml(displayName(client))}</strong><small>${escapeHtml(workflowLabel(client))} · ${escapeHtml(client.type)}</small></span>
      <span class="calendar-chevron">›</span>
    </button>`).join('');
  calendarDayDialog.showModal();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

function updateLiveDate() {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: '2-digit', year: 'numeric' }).format(now);
  const sidebarDate = new Intl.DateTimeFormat('en-US', { month: 'long', day: '2-digit', year: 'numeric' }).format(now);
  const nextMonth = new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  document.querySelector('#dashboardDate').textContent = date;
  document.querySelector('#sidebarDate').textContent = sidebarDate;
  document.querySelector('#sidebarNextMonth').textContent = nextMonth;
}

async function loadClients(showError = true) {
  try {
    clients = await api('/api/clients');
    renderClients();
  } catch (error) {
    if (showError) showToast(error.message);
    const resultCount = document.querySelector('#resultCount');
    if (resultCount) resultCount.textContent = 'Unable to load clients';
  }
}

async function loadCurrentUser() {
  const response = await fetch('/api/auth/me');
  const body = await response.json();
  if (!response.ok || !body.user) {
    window.location.href = '/';
    throw new Error('Please log in to continue.');
  }
  applyCurrentUser(body.user);
}

document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => {
  document.querySelector('.filter.active').classList.remove('active');
  button.classList.add('active');
  activeFilter = button.dataset.filter;
  scheduleMonthOffset = activeFilter === 'for-acop' ? 1 : null;
  currentPage = 1;
  renderClients();
}));
document.querySelector('#searchInput').addEventListener('input', () => { currentPage = 1; renderClients(); });
document.querySelector('#pensionTypeFilter').addEventListener('change', (event) => {
  activePensionType = event.target.value;
  currentPage = 1;
  renderClients();
});
document.querySelector('#age80Filter').addEventListener('change', (event) => {
  age80Only = event.target.checked;
  currentPage = 1;
  renderClients();
});
function showScheduleList(offset) {
  openClientList();
  const filterButton = document.querySelector('[data-filter="for-acop"]');
  document.querySelector('.filter.active').classList.remove('active');
  filterButton.classList.add('active');
  activeFilter = 'for-acop';
  scheduleMonthOffset = offset;
  currentPage = 1;
  renderClients();
}
document.querySelector('#viewDueButton').addEventListener('click', () => showScheduleList(0));
function openClientList() {
  window.location.hash = '#clients';
  showPage('clients');
}
document.querySelector('#totalClientsCard').addEventListener('click', openClientList);
document.querySelector('#totalClientsCard').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openClientList();
  }
});
document.querySelector('#followUpCard').addEventListener('click', () => {
  showScheduleList(1);
});
document.querySelector('#followUpCard').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    showScheduleList(1);
  }
});
document.querySelector('#previousCalendarMonth').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
document.querySelector('#nextCalendarMonth').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
document.querySelector('#calendarGrid').addEventListener('click', (event) => {
  const dayButton = event.target.closest('[data-calendar-day]');
  if (!dayButton) return;
  const day = Number(dayButton.dataset.calendarDay);
  const target = clients.filter((client) => {
    const date = client.acopScheduleDate ? new Date(client.acopScheduleDate) : null;
    return date && date.getUTCMonth() === calendarMonth.getMonth() && date.getUTCDate() === day;
  });
  if (target.length) {
    openCalendarDayDialog(target, day);
  }
});
document.querySelector('#calendarDayDialogItems').addEventListener('click', (event) => {
  const item = event.target.closest('[data-calendar-dialog-client]');
  if (!item) return;
  const client = clients.find((candidate) => candidate._id === item.dataset.calendarDialogClient);
  if (client) {
    calendarDayDialog.close();
    openDetails(client);
  }
});
document.querySelectorAll('#closeCalendarDayDialog, #closeCalendarDayDialogButton').forEach((button) => button.addEventListener('click', () => calendarDayDialog.close()));
table.addEventListener('click', async (event) => {
  const action = event.target.closest('.row-action');
  if (!action) return;
  const client = clients.find((item) => item._id === action.dataset.id);
  if (!client) return;
  if (action.dataset.action === 'view') return openDetails(client);
  if (action.dataset.action === 'edit') return openEdit(client);
  if (action.dataset.action === 'archive') {
    if (!await requestConfirmation(`Archive ${displayName(client)}? This will remove the record from the active list.`)) return;
    try {
      await api(`/api/clients/${client._id}`, { method: 'DELETE' });
      clients = clients.filter((item) => item._id !== client._id);
      renderClients();
      showToast(`${client.name} was archived.`);
    } catch (error) { showToast(error.message); }
    return;
  }
  const nextStatus = action.dataset.action === 'done' ? 'approval' : 'approved';
  let proofUrl;
  if (nextStatus === 'approval') {
    proofUrl = await requestProof(client);
    if (!proofUrl) return;
  }
  try {
    const updated = await api(`/api/clients/${client._id}/status`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus, proofUrl }) });
    clients = clients.map((item) => item._id === updated._id ? updated : item);
    showToast(`${client.name} moved to ${labels[nextStatus]}.`);
    renderClients();
  } catch (error) { showToast(error.message); }
});
function requestProof(client) {
  proofDialogClient = client;
  document.querySelector('#proofClientName').textContent = displayName(client);
  proofForm.reset();
  proofError.hidden = true;
  proofError.textContent = '';
  proofDialog.showModal();
  proofUrlInput.focus();
  return new Promise((resolve) => {
    proofDialog._resolve = resolve;
  });
}
function closeProofDialog(value = null) {
  if (!proofDialog.open) return;
  proofDialog.close();
  const resolve = proofDialog._resolve;
  proofDialog._resolve = null;
  proofDialogClient = null;
  if (resolve) resolve(value);
}
proofForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!proofConfirmation.checked) {
    proofError.textContent = 'Please confirm that the client completed ACOP/APIR.';
    proofError.hidden = false;
    return;
  }
  const value = proofUrlInput.value.trim();
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    proofError.textContent = 'Please enter a valid http or https proof image link.';
    proofError.hidden = false;
    return;
  }
  closeProofDialog(value);
});
document.querySelectorAll('#closeProofDialog, #cancelProofDialog').forEach((button) => button.addEventListener('click', () => closeProofDialog()));
function requestConfirmation(message) {
  document.querySelector('#confirmMessage').textContent = message;
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog._resolve = resolve;
  });
}
function closeConfirmDialog(value = false) {
  if (!confirmDialog.open) return;
  confirmDialog.close();
  const resolve = confirmDialog._resolve;
  confirmDialog._resolve = null;
  if (resolve) resolve(value);
}
confirmForm.addEventListener('submit', (event) => { event.preventDefault(); closeConfirmDialog(true); });
document.querySelectorAll('#closeConfirmDialog, #cancelConfirmDialog').forEach((button) => button.addEventListener('click', () => closeConfirmDialog()));
document.querySelectorAll('#addClientButton, #addClientHeaderButton').forEach((button) => button.addEventListener('click', () => {
  editingClientId = null;
  clientForm.reset();
  clientForm.elements.ref.value = 'ACOP record';
  document.querySelector('#clientDialogEyebrow').textContent = 'New record';
  document.querySelector('#clientDialogTitle').textContent = 'Add client';
  document.querySelector('#saveClientButton').textContent = 'Save client';
  clientDialog.showModal();
}));
document.querySelectorAll('#closeClientDialog, #cancelClientDialog').forEach((button) => button.addEventListener('click', () => clientDialog.close()));
clientForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(clientForm);
  const date = form.get('date');
  const payload = {
    name: form.get('name').trim(),
    type: form.get('type').trim(),
    ref: form.get('ref').trim(),
    date,
    day: date ? Number(date.slice(-2)) : 0,
    memberBirthday: form.get('memberBirthday') || '',
    contact: form.get('contact').trim(),
    status: 'for-acop',
    sub: form.get('sub').trim()
  };
  try {
    const saved = editingClientId
      ? await api(`/api/clients/${editingClientId}`, { method: 'PATCH', body: JSON.stringify(payload) })
      : await api('/api/clients', { method: 'POST', body: JSON.stringify(payload) });
    clients = editingClientId ? clients.map((item) => item._id === saved._id ? saved : item) : [...clients, saved];
    clientDialog.close();
    renderClients();
    showToast(`${saved.name} was ${editingClientId ? 'updated' : 'added'} in MongoDB.`);
    editingClientId = null;
  } catch (error) { showToast(error.message); }
});

function openEdit(client) {
  editingClientId = client._id;
  Object.entries({ name: client.name, type: client.type, ref: client.ref, date: client.date, memberBirthday: client.memberBirthday || client.sourceData?.['MEMBERS B-DAY'], contact: client.contact, sub: client.sub })
    .forEach(([field, value]) => { clientForm.elements[field].value = value || ''; });
  document.querySelector('#clientDialogEyebrow').textContent = 'Edit record';
  document.querySelector('#clientDialogTitle').textContent = 'Edit client';
  document.querySelector('#saveClientButton').textContent = 'Save changes';
  clientDialog.showModal();
}

function openDetails(client) {
  document.querySelector('#detailsTitle').textContent = client.name;
  const fields = [
    ['Pension type', repairText(client.type)], ['Status', workflowLabel(client)], ['Birthday', client.date],
    ['ACOP reference', repairText(client.ref)], ['Contact', displayContact(client.contact)], ['SS/GSIS number', displayIdentifier(client.sub)],
    ['Address', repairText(client.sourceData?.['ADDRESS (NO. / BLDG / STREET)'])], ['Barangay', repairText(client.sourceData?.BARANGAY)],
    ['Municipality', repairText(client.sourceData?.MUNICIPAL)], ['Province', repairText(client.sourceData?.PROVINCE)],
    ['Email', repairText(client.sourceData?.['EMAIL ADDRESS'])], ['ACOP date complied', client.sourceData?.['ACOP DATE COMPLIED']],
    ['Proof image', client.proofUrl]
  ];
  document.querySelector('#detailsGrid').innerHTML = fields.filter(([, value]) => value).map(([label, value]) => {
    const content = label === 'Proof image'
      ? `<a href="${escapeHtml(value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(value)}</a><img class="proof-preview" src="${escapeHtml(value)}" alt="ACOP proof image" loading="lazy">`
      : escapeHtml(value);
    return `<div><dt>${escapeHtml(label)}</dt><dd>${content}</dd></div>`;
  }).join('');
  detailsDialog.showModal();
}
document.querySelectorAll('#closeDetailsDialog, #closeDetailsButton').forEach((button) => button.addEventListener('click', () => detailsDialog.close()));
document.querySelector('#exportReportButton').addEventListener('click', () => {
  const headers = ['Name', 'Pension type', 'ACOP reference', 'Birthday', 'Contact', 'SS/GSIS number', 'Status'];
  const rows = clients.map((client) => [displayName(client), repairText(client.type), repairText(client.ref), client.date, displayContact(client.contact), displayIdentifier(client.sub), workflowLabel(client)]);
  const csv = [headers, ...rows].map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  link.download = `acop-report-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast('Report exported as CSV.');
});
document.querySelector('#excelImportInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const response = await fetch('/api/clients/import', { method: 'POST', body: formData });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to import Excel file.');
    await loadClients();
    showToast(`${result.imported} client${result.imported === 1 ? '' : 's'} imported. ${result.skipped} skipped.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    event.target.value = '';
  }
});
document.querySelector('#notifyButton').addEventListener('click', async () => {
  if (!('Notification' in window)) return showToast('Browser notifications are not supported here.');
  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    try {
      await subscribeToPushNotifications();
      document.querySelector('#notifyButton').innerHTML = '<span class="bell">♢</span><span>Notifications enabled</span>';
      showToast('Push notifications are enabled. Daily reminders will appear automatically.');
    } catch (error) { showToast(error.message); }
  }
  else showToast('Notification permission was not enabled.');
});
document.querySelector('#logoutButton').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  window.location.href = '/';
});

const sidebar = document.querySelector('.sidebar');
const menuToggle = document.querySelector('#menuToggle');
const sidebarBackdrop = document.querySelector('#sidebarBackdrop');
const appShell = document.querySelector('.app-shell');

function setSidebarOpen(isOpen) {
  sidebar.classList.toggle('is-open', isOpen);
  appShell.classList.toggle('sidebar-open', isOpen);
  sidebarBackdrop.classList.toggle('is-visible', isOpen);
  menuToggle.setAttribute('aria-expanded', String(isOpen));
  menuToggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
}

menuToggle.addEventListener('click', () => setSidebarOpen(!sidebar.classList.contains('is-open')));
sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));

function showPage(page) {
  const validPage = document.querySelector(`[data-view="${page}"]`) ? page : 'dashboard';
  document.querySelectorAll('[data-view]').forEach((view) => view.classList.toggle('active', view.dataset.view === validPage));
  document.querySelectorAll('.nav-item[data-page]').forEach((item) => item.classList.toggle('active', item.dataset.page === validPage));
  setSidebarOpen(false);
  document.title = `${validPage === 'dashboard' ? 'Dashboard' : validPage === 'clients' ? 'Client records' : validPage === 'calendar' ? 'ACOP calendar' : 'Reports'} | ACOP Watch`;
}

window.addEventListener('hashchange', () => showPage(window.location.hash.slice(1)));
showPage(window.location.hash.slice(1) || 'dashboard');
loadCurrentUser().then(() => loadClients()).catch((error) => showToast(error.message));
updateLiveDate();
window.setInterval(updateLiveDate, 30000);
window.setInterval(() => loadClients(false), 30000);
