// Adena Monitor — staff dashboard.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, update, push, serverTimestamp, query, limitToLast, orderByChild, equalTo,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { CONFIG } from './config.js';
import {
  emailKey, keyToEmail, activePolicies, evaluate, domains, keywords, list, REASON_TEXT, GRADE_ORDER, gradeLabel,
} from './filter-core.js';

const app = initializeApp(CONFIG.firebase);
const auth = getAuth(app);
const db = getDatabase(app);
const $ = (id) => document.getElementById(id);

const S = {
  me: null, role: null, userRec: null, staffFlag: false, config: {}, serverOffset: 0, loadAt: Date.now(),
  roleSig: '', dataSubs: [], perStudentSubs: new Map(),
  rosters: {}, gradeStudents: {}, idx: new Map(), myCourses: [], online: {},
  view: { type: 'overview' }, viewSubs: [], gridSubs: new Map(), shownSig: '',
  presence: {}, screens: {}, selected: new Set(), filters: { online: true, course: '', q: '' },
  drawerKey: null, drawerTab: 'screen', drawerSubs: [], history: [], devSessions: [], studentAlerts: [],
  alerts: [], alertIds: new Set(), unseen: 0, policies: {}, viewerTimer: null,
};

// ---------- small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const serverNow = () => Date.now() + S.serverOffset;
const fmt = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const fmtTime = (ts) => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const lines = (t) => String(t || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
const emailsToMap = (t) => Object.fromEntries(lines(t).map((e) => [emailKey(e), true]));
const mapToEmails = (m) => Object.keys(m || {}).map(keyToEmail).join('\n');
const unsubAll = (arr) => { arr.forEach((u) => { try { u(); } catch {} }); arr.length = 0; };
const mode = () => S.config.accessMode || 'own_classes';
const isAdmin = () => S.role === 'admin';
const isLead = () => S.role === 'admin' || S.role === 'principal';
const canUse = () => isLead() || (S.role === 'teacher' && mode() !== 'admins_only');
const seesAll = () => isAdmin() || (S.role === 'teacher' && mode() === 'any_student');
const myGrades = () => Object.keys((S.userRec && S.userRec.grades) || {});
const isOnline = (k) => { const t = S.online[k]; return !!t && serverNow() - t < 150000; };
const sortGrades = (gs) => [...gs].sort((a, b) => GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b));
const shortGrade = (g) => (g ? g : '–');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Period number from a class name or section: "Period 3", "Per. 3", "P3", "3rd Period", "Pd 3".
function periodOf(c) {
  const t = `${c.name || ''} ${c.section || ''}`;
  const m = t.match(/\b(?:period|per\.?|pd\.?|p)\s*(\d{1,2})\b/i) || t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:period|per\b|pd\b)/i);
  return m ? Number(m[1]) : 99;
}
// Class name without a leading "Period 3" (the period number is shown separately).
const classTitle = (c) => (periodOf(c) < 99 ? (c.name || '').replace(/^\s*(?:period|per\.?|pd\.?|p)\s*\d{1,2}\s*[-:–]?\s*/i, '') : c.name) || c.name || 'Class';
const byPeriod = (a, b) => periodOf(a) - periodOf(b) || (a.name || '').localeCompare(b.name || '') || (a.section || '').localeCompare(b.section || '');
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }
const ROLE_LABEL = { admin: 'Admin', principal: 'Principal', teacher: 'Teacher' };

function toast(msg, opts = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (opts.alert ? ' alert' : '');
  el.innerHTML = msg;
  if (opts.onClick) el.onclick = () => { opts.onClick(); el.remove(); };
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), opts.alert ? 12000 : 3500);
}

function modal(html, onMount) {
  $('modal-card').innerHTML = html;
  $('modal').classList.remove('hidden');
  const close = () => $('modal').classList.add('hidden');
  $('modal-card').querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  const first = $('modal-card').querySelector('input,textarea,select');
  first && first.focus();
  onMount && onMount($('modal-card'), close);
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('modal').classList.contains('hidden')) $('modal').classList.add('hidden');
  else if (S.drawerKey) closeDrawer();
});

function audit(action, target, detail = {}) {
  try {
    Promise.resolve(push(ref(db, 'audit'), { by: S.me.key, email: S.me.email, action, target: target || '', detail, ts: serverTimestamp() })).catch(() => {});
  } catch {}
}
function bumpRev() { return set(ref(db, 'meta/rev'), serverTimestamp()).catch(() => {}); }

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.18);
  } catch {}
}

const student = (k) => S.idx.get(k) || { key: k, email: keyToEmail(k), name: keyToEmail(k), grade: '', courses: [] };

// ---------- sign in ----------
document.title = CONFIG.PRODUCT_NAME;
$('signin-title').textContent = CONFIG.PRODUCT_NAME;
$('brand-name').textContent = CONFIG.PRODUCT_NAME;
$('brand-school').textContent = CONFIG.SCHOOL_NAME;
$('signin-btn').onclick = async () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: CONFIG.DOMAIN, prompt: 'select_account' });
  try { await signInWithPopup(auth, provider); } catch (e) { $('signin-err').textContent = e.message; }
};
$('signout').onclick = () => signOut(auth);
$('brand').onclick = (e) => { e.preventDefault(); openView({ type: 'overview' }); };

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    $('app').classList.add('hidden');
    $('signin').classList.remove('hidden');
    return;
  }
  const email = (user.email || '').toLowerCase();
  if (!email.endsWith('@' + CONFIG.DOMAIN)) {
    $('signin-err').textContent = `Sign in with your @${CONFIG.DOMAIN} account.`;
    await signOut(auth);
    return;
  }
  S.me = { email, key: emailKey(email), name: user.displayName || email };
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('me-name').textContent = S.me.name;
  onValue(ref(db, '.info/serverTimeOffset'), (s) => (S.serverOffset = s.val() || 0));
  onValue(ref(db, `users/${S.me.key}`), (s) => { S.userRec = s.val(); applyRole(); });
  S.staffFlag = !!(await get(ref(db, `staff/${S.me.key}`)).then((s) => s.val()).catch(() => false));
  onValue(ref(db, 'config'), (snap) => { S.config = snap.val() || {}; applyRole(); },
    (err) => { $('main').innerHTML = `<div class="empty">Settings could not be loaded: ${esc(err.message)}</div>`; });
});

function applyRole() {
  const c = S.config;
  const u = S.userRec;
  if (u && u.active === false) S.role = null;
  else if ((c.admins && c.admins[S.me.key]) || (u && u.role === 'admin')) S.role = 'admin';
  else if (u && u.role === 'principal') S.role = 'principal';
  else if (S.staffFlag || (c.extraStaff && c.extraStaff[S.me.key]) || (u && u.role === 'teacher')) S.role = 'teacher';
  else S.role = null;
  $('me-role').textContent = S.role ? ROLE_LABEL[S.role] : 'No access';
  const sig = [S.role, mode(), myGrades().join(','), JSON.stringify((u && u.courses) || {})].join('|');
  if (sig !== S.roleSig) { S.roleSig = sig; loadData(); }
  renderNav();
}

// ---------- data loading ----------
function loadData() {
  unsubAll(S.dataSubs);
  S.perStudentSubs.forEach((arr) => unsubAll(arr));
  S.perStudentSubs.clear();
  S.rosters = {}; S.gradeStudents = {}; S.online = {};
  rebuildIdx();
  if (!canUse()) { openView({ type: 'overview' }); return; }

  if (seesAll()) {
    S.dataSubs.push(onValue(ref(db, 'gradeStudents'), (s) => { S.gradeStudents = s.val() || {}; rebuildIdx(); }));
    S.dataSubs.push(onValue(ref(db, 'rosters'), (s) => { S.rosters = s.val() || {}; rebuildIdx(); }));
    S.dataSubs.push(onValue(ref(db, 'online'), (s) => { S.online = s.val() || {}; onOnlineChanged(); }));
  } else if (S.role === 'principal') {
    myGrades().forEach((g) => S.dataSubs.push(onValue(ref(db, `gradeStudents/${g}`), (s) => {
      S.gradeStudents = { ...S.gradeStudents, [g]: s.val() || {} }; rebuildIdx();
    })));
    S.dataSubs.push(onValue(ref(db, 'rosters'), (s) => { S.rosters = s.val() || {}; rebuildIdx(); }));
    S.dataSubs.push(onValue(ref(db, 'online'), (s) => { S.online = s.val() || {}; onOnlineChanged(); }));
  } else {
    const inner = [];
    S.dataSubs.push(onValue(ref(db, `teacherCourses/${S.me.key}`), (s) => {
      unsubAll(inner);
      S.rosters = {};
      Object.keys(s.val() || {}).forEach((cid) => inner.push(onValue(ref(db, `rosters/${cid}`), (r) => {
        if (r.val()) S.rosters[cid] = r.val(); else delete S.rosters[cid];
        rebuildIdx();
      })));
      rebuildIdx();
    }));
    S.dataSubs.push(() => unsubAll(inner));
  }

  if (isLead()) {
    S.dataSubs.push(onValue(query(ref(db, 'alertLog'), limitToLast(40)), (s) => {
      Object.entries(s.val() || {}).forEach(([id, a]) => {
        if (S.role === 'principal' && !S.idx.has(a.student)) return;
        handleAlert(id, a);
      });
    }));
  }
  openView(S.view && S.view.type ? S.view : { type: 'overview' });
}

function rebuildIdx() {
  const idx = new Map();
  const gradesOk = S.role === 'principal' ? new Set(myGrades()) : null;
  Object.entries(S.gradeStudents || {}).forEach(([g, members]) => {
    if (gradesOk && !gradesOk.has(g)) return;
    Object.entries(members || {}).forEach(([k, v]) => idx.set(k, { key: k, email: v.e, name: v.n || v.e, grade: g, courses: [] }));
  });
  Object.entries(S.rosters || {}).forEach(([cid, r]) => {
    Object.entries(r.students || {}).forEach(([k, v]) => {
      if (!idx.has(k)) {
        if (gradesOk) return; // principals see their grade levels only
        idx.set(k, { key: k, email: v.e, name: v.n || v.e, grade: v.g || '', courses: [] });
      }
      idx.get(k).courses.push(cid);
    });
  });
  S.idx = idx;
  S.myCourses = Object.entries(S.rosters).filter(([, r]) => r.teachers && r.teachers[S.me.key])
    .map(([id, r]) => ({ id, ...r })).sort(byPeriod);

  // Teachers without a school-wide online feed: watch each of their students (online + alerts).
  if (!seesAll() && S.role === 'teacher') {
    const want = new Set(idx.keys());
    S.perStudentSubs.forEach((arr, k) => { if (!want.has(k)) { unsubAll(arr); S.perStudentSubs.delete(k); } });
    want.forEach((k) => {
      if (S.perStudentSubs.has(k)) return;
      S.perStudentSubs.set(k, [
        onValue(ref(db, `online/${k}`), (s) => { S.online[k] = s.val(); onOnlineChanged(); }),
        onValue(query(ref(db, `alerts/${k}`), limitToLast(1)), (s) => {
          Object.entries(s.val() || {}).forEach(([id, a]) => handleAlert(id, { ...a, student: k, email: student(k).email, name: student(k).name }));
        }),
      ]);
    });
  }
  renderNav();
  refreshView();
}

let onlineTimer = null;
function onOnlineChanged() {
  clearTimeout(onlineTimer);
  onlineTimer = setTimeout(() => { renderNav(); refreshView(true); }, 400);
}
setInterval(() => { if (S.role) { renderNav(); refreshView(true); } }, 30000);

// ---------- alerts ----------
function handleAlert(id, a) {
  if (S.alertIds.has(id)) return;
  S.alertIds.add(id);
  S.alerts.unshift({ id, ...a });
  S.alerts.sort((x, y) => (y.ts || 0) - (x.ts || 0));
  S.alerts = S.alerts.slice(0, 60);
  const fresh = a.ts && a.ts > S.loadAt - 5000;
  if (fresh) {
    S.unseen++;
    $('bell').classList.remove('ring'); void $('bell').offsetWidth; $('bell').classList.add('ring');
    beep();
    toast(`<b>Tamper alert</b><br>${esc(a.name || a.email)}: ${esc(a.detail || a.type)}`, {
      alert: true, onClick: () => openDrawer(a.student),
    });
  }
  renderBell();
  if (S.view.type === 'overview') refreshView();
}

function renderBell() {
  $('bell-count').textContent = S.unseen;
  $('bell-count').classList.toggle('hidden', !S.unseen);
  if ($('bell-panel').classList.contains('hidden')) return;
  $('bell-panel').innerHTML = `<h3>Tamper alerts</h3>${alertFeed(S.alerts.slice(0, 25))}`;
  wireFeed($('bell-panel'));
}
$('bell').onclick = (e) => {
  e.stopPropagation();
  $('bell-panel').classList.toggle('hidden');
  S.unseen = 0;
  renderBell();
};
document.addEventListener('click', (e) => {
  if (!$('bell-panel').contains(e.target)) $('bell-panel').classList.add('hidden');
  if (!$('search').parentElement.contains(e.target)) $('search-results').classList.add('hidden');
});

function alertFeed(items) {
  if (!items.length) return '<div class="empty">No tamper alerts. Students who click the extension or try to open the extensions page show up here.</div>';
  return `<ul class="feed">${items.map((a) => `<li class="alert">
    <span class="t">${esc(fmtTime(a.ts))}</span>
    <div><p class="who"><a href="#" data-student="${esc(a.student)}">${esc(a.name || a.email)}</a> ${a.grade ? `<span class="tag blue">${esc(shortGrade(a.grade))}</span>` : ''}</p>
    <div class="what">${esc(a.detail || a.type)}</div>
    <div class="meta">${a.serial ? 'Device ' + esc(a.serial) : ''}${a.url ? (a.serial ? ', on ' : 'On ') + esc(a.url) : ''}</div></div></li>`).join('')}</ul>`;
}
function wireFeed(el) {
  el.querySelectorAll('[data-student]').forEach((x) => (x.onclick = (e) => { e.preventDefault(); openDrawer(x.dataset.student); }));
}

// ---------- search ----------
$('search').oninput = () => {
  const q = $('search').value.trim().toLowerCase();
  const box = $('search-results');
  if (q.length < 2) { box.classList.add('hidden'); return; }
  const hits = [...S.idx.values()].filter((s) => s.name.toLowerCase().includes(q) || s.email.includes(q)).slice(0, 12);
  box.innerHTML = hits.length
    ? hits.map((s) => `<button data-k="${esc(s.key)}"><b>${esc(s.name)}</b> <span class="hint">${esc(gradeLabel(s.grade))}, ${esc(s.email)}</span></button>`).join('')
    : '<div class="empty">No students match.</div>';
  box.classList.remove('hidden');
  box.querySelectorAll('[data-k]').forEach((b) => (b.onclick = () => { box.classList.add('hidden'); $('search').value = ''; openDrawer(b.dataset.k); }));
};

// ---------- navigation ----------
function gradesPresent() {
  const gs = new Set();
  S.idx.forEach((s) => gs.add(s.grade || ''));
  const out = sortGrades([...gs].filter(Boolean));
  if (gs.has('')) out.push('');
  return out;
}
function countGrade(g) {
  let total = 0, on = 0;
  S.idx.forEach((s) => { if ((s.grade || '') === g) { total++; if (isOnline(s.key)) on++; } });
  return { total, on };
}

function renderNav() {
  const v = S.view || {};
  const item = (type, id, label, extra = '', count = '') =>
    `<button class="nav-item${v.type === type && String(v.id ?? '') === String(id ?? '') ? ' active' : ''}" data-type="${type}" data-id="${esc(id ?? '')}">${extra}<span>${esc(label)}</span>${count}</button>`;
  let html = '';
  if (!canUse()) {
    html = `<div class="nav-title" style="padding-top:16px">You don't have access to ${esc(CONFIG.PRODUCT_NAME)} yet. Ask an admin to add you on the Users page.</div>`;
  } else {
    html += item('overview', '', isLead() ? 'Overview' : 'Home');
    const classesNav = () => {
      if (!S.myCourses.length) return '';
      let h = '<div class="nav-group"><div class="nav-title">My classes</div>';
      h += S.myCourses.map((c) => {
        const ks = Object.keys(c.students || {});
        const on = ks.filter(isOnline).length;
        const per = periodOf(c);
        return item('course', c.id, classTitle(c), per < 99 ? `<span class="num">${per}</span>` : '<span class="num"></span>', `<span class="count${on ? ' live' : ''}">${on}/${ks.length}</span>`);
      }).join('');
      return h + '</div>';
    };
    if (!isLead()) html += classesNav();
    const grades = gradesPresent();
    if (grades.length) {
      html += '<div class="nav-group"><div class="nav-title">Grade levels</div>';
      html += grades.map((g) => {
        const c = countGrade(g);
        return item('grade', g, g ? gradeLabel(g) : 'No grade', `<span class="num">${esc(g || '–')}</span>`,
          `<span class="count${c.on ? ' live' : ''}">${c.on}/${c.total}</span>`);
      }).join('');
      html += '</div>';
    }
    if (isLead()) html += classesNav();
    if (isLead()) {
      html += '<div class="nav-group"><div class="nav-title">Manage</div>';
      html += item('filtering', '', 'Web filtering') + item('reports', '', 'Reports') + item('devices', '', 'Devices');
      if (isAdmin()) html += item('users', '', 'Users') + item('settings', '', 'Settings');
      html += '</div>';
    }
  }
  $('nav').innerHTML = html;
  $('nav').querySelectorAll('.nav-item').forEach((b) => (b.onclick = () => openView({ type: b.dataset.type, id: b.dataset.id })));
}

// ---------- views ----------
function openView(view) {
  unsubAll(S.viewSubs);
  S.gridSubs.forEach((arr) => unsubAll(arr));
  S.gridSubs.clear();
  S.shownSig = '';
  S.selected.clear();
  S.filters = { online: true, course: '', q: '', layout: view.type === 'course' ? 'tabs' : 'screens' };
  S.view = view;
  clearInterval(S.viewerTimer);
  renderNav();
  $('main').scrollTop = 0;
  if (!canUse()) { $('main').innerHTML = `<div class="empty">You don't have access to ${esc(CONFIG.PRODUCT_NAME)} yet. Ask an admin to add you on the Users page.</div>`; return; }
  const t = view.type;
  if (t === 'overview') renderOverview();
  else if (t === 'grade' || t === 'course') renderMonitor();
  else if (t === 'filtering' && isLead()) renderFiltering();
  else if (t === 'reports' && isLead()) renderReports();
  else if (t === 'devices' && isLead()) renderDevices();
  else if (t === 'users' && isAdmin()) renderUsers();
  else if (t === 'settings' && isAdmin()) renderSettings();
  else renderOverview();
}

function refreshView(onlineOnly = false) {
  const t = S.view.type;
  if (t === 'overview') renderOverview();
  else if (t === 'grade' || t === 'course') refreshGrid(onlineOnly);
}

// ---------- overview ----------
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function renderTeacherHome() {
  const first = (S.me.name || '').split(' ')[0];
  const cards = S.myCourses.map((c) => {
    const ks = Object.keys(c.students || {});
    const on = ks.filter(isOnline).length;
    const per = periodOf(c);
    return `<button class="class-card" data-course="${esc(c.id)}">
      <span class="per">${per < 99 ? per : ''}</span>
      <span class="cc-body"><b>${esc(classTitle(c))}</b><span class="hint">${esc([c.section, c.room].filter(Boolean).join(', '))}</span></span>
      <span class="cc-on"><b>${on}</b> online<br><span class="hint">of ${ks.length}</span></span></button>`;
  }).join('');
  $('main').innerHTML = `
    <div class="page-head"><div><h1>${esc(greeting())}, ${esc(first)}</h1><div class="sub">Pick a class to see every student’s open tabs, live.</div></div></div>
    ${S.myCourses.length ? `<div class="class-board">${cards}</div>` : '<div class="panel"><div class="empty">You don’t have any Google Classroom classes yet. Classes load from Google Classroom every hour.</div></div>'}
    <div class="panel" style="margin-top:22px"><h2>Tamper alerts</h2>${alertFeed(S.alerts.slice(0, 10))}</div>`;
  $('main').querySelectorAll('[data-course]').forEach((b) => (b.onclick = () => openView({ type: 'course', id: b.dataset.course })));
  wireFeed($('main'));
}

function renderOverview() {
  if (!canUse()) return;
  if (!isLead()) return renderTeacherHome();
  const grades = gradesPresent();
  let totalOn = 0;
  S.idx.forEach((s) => { if (isOnline(s.key)) totalOn++; });
  const first = (S.me.name || '').split(' ')[0];
  const board = grades.length ? `<div class="scoreboard">${grades.map((g) => {
    const c = countGrade(g);
    const pct = c.total ? Math.round((c.on / c.total) * 100) : 0;
    return `<button class="score" data-g="${esc(g)}"><div class="g">${esc(g || '–')}</div><div class="lbl">${esc(g ? gradeLabel(g) : 'No grade')}</div>
      <div class="on">${c.on} <small>online of ${c.total}</small></div><div class="bar"><i style="width:${pct}%"></i></div></button>`;
  }).join('')}</div>` : `<div class="panel"><div class="empty">${S.role === 'principal' && !myGrades().length
    ? 'No grade levels are assigned to you yet. Ask an admin to assign them on the Users page.'
    : 'No students yet. Rosters load from Google Classroom and Google Admin every hour.'}</div></div>`;

  const right = isLead()
    ? `<div class="panel"><h2>Blocked sites</h2><div id="ov-blocked">${blockedFeed()}</div></div>`
    : `<div class="panel"><h2>My classes</h2>${S.myCourses.length ? `<ul class="feed">${S.myCourses.map((c) => {
        const ks = Object.keys(c.students || {});
        return `<li><span class="t">${ks.filter(isOnline).length}/${ks.length}</span><div><a href="#" data-course="${esc(c.id)}"><b>${esc(c.name)}</b></a><div class="meta">${esc(c.section || '')}</div></div></li>`;
      }).join('')}</ul>` : '<div class="empty">You have no Google Classroom classes.</div>'}</div>`;

  $('main').innerHTML = `
    <div class="page-head"><div><h1>${esc(greeting())}, ${esc(first)}</h1>
      <div class="sub">${totalOn} of ${S.idx.size} students are online right now.</div></div></div>
    ${board}
    <div class="split">
      <div class="panel"><h2>Tamper alerts</h2>${alertFeed(S.alerts.slice(0, 12))}</div>
      ${right}
    </div>`;
  $('main').querySelectorAll('.score').forEach((b) => (b.onclick = () => openView({ type: 'grade', id: b.dataset.g })));
  $('main').querySelectorAll('[data-course]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); openView({ type: 'course', id: a.dataset.course }); }));
  wireFeed($('main'));
  if (isLead() && !S.viewSubs.length) {
    S.viewSubs.push(onValue(query(ref(db, 'blockLog'), limitToLast(60)), (s) => {
      S.ovBlocked = Object.values(s.val() || {}).filter((r) => S.role !== 'principal' || S.idx.has(r.student))
        .sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 12);
      const el = $('ov-blocked');
      if (el) { el.innerHTML = blockedFeed(); wireFeed(el); }
    }));
  }
}

function blockedFeed() {
  const rows = S.ovBlocked;
  if (!rows) return '<div class="empty">Loading…</div>';
  return rows.length ? `<ul class="feed">${rows.map((r) => `<li><span class="t">${esc(fmtTime(r.ts))}</span>
    <div><p class="who"><a href="#" data-student="${esc(r.student)}">${esc(student(r.student).name || r.email)}</a></p>
    <div class="meta">${esc(r.url)}</div><div class="hint">${esc(r.policy || r.reason)}</div></div></li>`).join('')}</ul>`
    : '<div class="empty">Nothing blocked yet.</div>';
}

// ---------- monitor (grade or class) ----------
function viewStudents() {
  const v = S.view;
  let ks;
  if (v.type === 'course') ks = Object.keys((S.rosters[v.id] || {}).students || {});
  else ks = [...S.idx.values()].filter((s) => (s.grade || '') === (v.id || '')).map((s) => s.key);
  return ks.map(student).sort((a, b) => a.name.localeCompare(b.name));
}

function shownStudents() {
  const f = S.filters;
  const q = f.q.toLowerCase();
  return viewStudents().filter((s) =>
    (!f.online || isOnline(s.key)) &&
    (!f.course || s.courses.includes(f.course)) &&
    (!q || s.name.toLowerCase().includes(q) || s.email.includes(q)));
}

function renderMonitor() {
  const v = S.view;
  const all = viewStudents();
  const course = v.type === 'course' ? S.rosters[v.id] || {} : null;
  const classIds = v.type === 'grade'
    ? [...new Set(all.flatMap((s) => s.courses))].filter((c) => S.rosters[c])
      .sort((a, b) => (S.rosters[a].name || '').localeCompare(S.rosters[b].name || ''))
    : [];
  const head = v.type === 'grade'
    ? `<span class="jersey">${esc(v.id || '–')}</span><div><h1>${esc(v.id ? gradeLabel(v.id) : 'No grade')}</h1><div class="sub" id="mon-sub"></div></div>`
    : `${periodOf(course) < 99 ? `<span class="jersey">${periodOf(course)}</span>` : ''}<div><h1>${esc(classTitle(course))}</h1><div class="sub">${esc([course.section, course.room].filter(Boolean).join(', '))}</div><div class="sub" id="mon-sub"></div></div>`;
  $('main').innerHTML = `
    <div class="page-head">${head}</div>
    <div class="filters">
      <div class="seg" role="group" aria-label="Show"><button data-on="1" class="on">Online</button><button data-on="0">Everyone</button></div>
      ${classIds.length ? `<select id="f-course" aria-label="Class"><option value="">All classes</option>${classIds.map((c) =>
        `<option value="${esc(c)}">${esc(S.rosters[c].name)}${S.rosters[c].section ? ' (' + esc(S.rosters[c].section) + ')' : ''}</option>`).join('')}</select>` : ''}
      <input id="f-q" type="search" placeholder="Filter by name" style="max-width:240px">
      <span class="grow"></span>
      <div class="seg" role="group" aria-label="Layout" id="f-layout"><button data-l="tabs" class="${S.filters.layout === 'tabs' ? 'on' : ''}">Tabs</button><button data-l="screens" class="${S.filters.layout === 'screens' ? 'on' : ''}">Screens</button></div>
    </div>
    <div class="actionbar">
      <span class="target" id="target"></span>
      <button class="btn small" id="a-focus">Focus mode…</button>
      <button class="btn small" id="a-unfocus">End focus</button>
      <button class="btn small" id="a-open">Open a site…</button>
      <button class="btn small" id="a-msg">Message…</button>
      <button class="btn small danger" id="a-lock">Lock screens…</button>
      <button class="btn small" id="a-unlock">Unlock</button>
      <label class="limit">Tab limit <select id="a-limit" aria-label="Tab limit"><option value="0">None</option>${[1, 2, 3, 4, 5, 6, 8, 10].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></label>
      <button class="btn small" id="a-others">Close all but current tab</button>
      <button class="btn small quiet hidden" id="a-clear">Clear selection</button>
    </div>
    <div class="sites" id="sites"></div>
    <div class="grid" id="grid"></div>
    <div class="more-note" id="more-note"></div>`;
  $('main').querySelectorAll('.seg button').forEach((b) => (b.onclick = () => {
    S.filters.online = b.dataset.on === '1';
    $('main').querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
    refreshGrid();
  }));
  if ($('f-course')) $('f-course').onchange = () => { S.filters.course = $('f-course').value; refreshGrid(); };
  $('f-q').oninput = () => { S.filters.q = $('f-q').value; refreshGrid(); };
  const label = () => (v.type === 'grade' ? gradeLabel(v.id) : course.name || 'class');
  $('a-focus').onclick = () => focusModal(targets(), label());
  $('a-unfocus').onclick = () => setForAll(targets(), 'focus', null, 'end_focus', label());
  $('a-open').onclick = () => openUrlModal(targets(), label());
  $('a-msg').onclick = () => messageModal(targets(), label());
  $('a-lock').onclick = () => lockModal(targets(), label());
  $('a-unlock').onclick = () => setForAll(targets(), 'lock', null, 'unlock', label());
  $('a-clear').onclick = () => { S.selected.clear(); refreshGrid(); };
  $('a-limit').onchange = () => {
    const max = Number($('a-limit').value);
    setForAll(targets(), 'tabLimit', max ? { max, by: S.me.key, ts: serverTimestamp() } : null, max ? 'tab_limit' : 'tab_limit_off', label(), { max });
  };
  $('a-others').onclick = () => {
    const ks = targets();
    if (ks.length && confirm(`Close every tab except the one on screen for ${countLine(ks)}?`)) sendCommand(ks, { type: 'closeOthers' }, 'close_other_tabs', label());
  };
  $('f-layout').querySelectorAll('button').forEach((b) => (b.onclick = () => {
    S.filters.layout = b.dataset.l;
    $('f-layout').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    $('grid').classList.toggle('rows', S.filters.layout === 'tabs');
    S.shownSig = '';
    refreshGrid();
  }));
  $('grid').classList.toggle('rows', S.filters.layout === 'tabs');
  audit(v.type === 'grade' ? 'view_grade' : 'view_class', label());
  refreshGrid();
  startViewer();
}

function targets() {
  if (S.selected.size) return [...S.selected];
  return shownStudents().filter((s) => isOnline(s.key) || S.view.type === 'course').map((s) => s.key);
}

const MAX_LIVE = 60;
function refreshGrid(onlineChangeOnly = false) {
  const grid = $('grid');
  if (!grid) return;
  const shown = shownStudents();
  const all = viewStudents();
  const on = all.filter((s) => isOnline(s.key)).length;
  if ($('mon-sub')) $('mon-sub').textContent = `${on} online of ${all.length} students`;
  const sel = S.selected.size;
  $('target').textContent = sel ? `${sel} selected` : `Acts on ${S.filters.online ? 'all online students shown' : 'everyone shown'}`;
  $('a-clear').classList.toggle('hidden', !sel);
  const sig = shown.map((s) => s.key).join(',');
  if (sig === S.shownSig && onlineChangeOnly) { shown.forEach((s) => paintTile(s.key)); return; }
  S.shownSig = sig;
  if (!shown.length) {
    grid.innerHTML = `<div class="empty">${S.filters.online ? 'Nobody here is online right now. Switch to Everyone to see the whole list.' : 'No students match.'}</div>`;
  } else {
    grid.innerHTML = shown.map((s) => `<div class="tile" id="t-${esc(s.key)}" data-k="${esc(s.key)}" tabindex="0" role="button" aria-label="${esc(s.name)}"></div>`).join('');
    grid.querySelectorAll('.tile').forEach((el) => {
      el.onclick = (e) => { if (e.target.classList.contains('pick')) return; openDrawer(el.dataset.k); };
      el.onkeydown = (e) => { if (e.key === 'Enter') openDrawer(el.dataset.k); };
    });
  }
  // Live data only for online students on screen (keeps the free plan's download quota low).
  const live = new Set(shown.filter((s) => isOnline(s.key)).slice(0, MAX_LIVE).map((s) => s.key));
  S.gridSubs.forEach((arr, k) => { if (!live.has(k)) { unsubAll(arr); S.gridSubs.delete(k); } });
  live.forEach((k) => {
    if (S.gridSubs.has(k)) return;
    S.gridSubs.set(k, [
      onValue(ref(db, `presence/${k}`), (s) => { S.presence[k] = s.val(); paintTile(k); paintSites(); if (S.drawerKey === k) renderDrawer(); }),
      onValue(ref(db, `screens/${k}`), (s) => { S.screens[k] = s.val(); paintTile(k); if (S.drawerKey === k) renderDrawer(); }),
    ]);
  });
  $('more-note').textContent = shown.filter((s) => isOnline(s.key)).length > MAX_LIVE
    ? `Live screens show for the first ${MAX_LIVE} online students. Pick a class to narrow the list.` : '';
  shown.forEach((s) => paintTile(s.key));
  paintSites();
}

// "Sites open right now" across the students on screen, with one-click close for the whole group.
let sitesTimer = null;
function paintSites() {
  clearTimeout(sitesTimer);
  sitesTimer = setTimeout(() => {
    const el = $('sites');
    if (!el) return;
    const counts = new Map();
    [...S.gridSubs.keys()].forEach((k) => {
      if (!isOnline(k)) return;
      const seen = new Set(list((S.presence[k] || {}).tabs).map((t) => domainOf(t.url)).filter(Boolean));
      seen.forEach((d) => counts.set(d, (counts.get(d) || new Set()).add(k)));
    });
    const top = [...counts.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 14);
    el.innerHTML = top.length ? `<span class="sites-title">Open right now</span>${top.map(([d, ks]) =>
      `<span class="site-chip"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=32" alt="">${esc(d)} <b>${ks.size}</b>
        <button title="Close ${esc(d)} for these students" aria-label="Close ${esc(d)} tabs for ${ks.size} students" data-site="${esc(d)}">×</button></span>`).join('')}` : '';
    el.querySelectorAll('[data-site]').forEach((b) => (b.onclick = () => {
      const d = b.dataset.site;
      const ks = [...(counts.get(d) || [])];
      if (confirm(`Close every ${d} tab for ${countLine(ks)}?`)) sendCommand(ks, { type: 'closeMatching', domain: d }, 'close_site', d);
    }));
    const limits = [...S.gridSubs.keys()].filter(isOnline).map((k) => (S.presence[k] || {}).tabLimit || 0);
    if ($('a-limit') && limits.length && document.activeElement !== $('a-limit')) {
      const common = limits.sort((a, b) => limits.filter((x) => x === b).length - limits.filter((x) => x === a).length)[0];
      $('a-limit').value = String(common || 0);
    }
  }, 300);
}

function paintTile(k) {
  if (S.filters.layout === 'tabs') return paintRow(k);
  const el = document.getElementById('t-' + k);
  if (!el) return;
  const s = student(k);
  const p = S.presence[k] || {};
  const sc = S.screens[k];
  const online = isOnline(k);
  const recentAlert = S.alerts.find((a) => a.student === k && a.ts && serverNow() - a.ts < 15 * 60 * 1000);
  const strip = recentAlert ? 'alert' : online ? (p.idle && p.idle !== 'active' ? 'idle' : 'on') : '';
  const act = p.active || {};
  el.className = 'tile' + (online ? '' : ' off') + (S.selected.has(k) ? ' sel' : '');
  el.innerHTML = `<input type="checkbox" class="pick" aria-label="Select ${esc(s.name)}" ${S.selected.has(k) ? 'checked' : ''}>
    <div class="shot">${online && sc && sc.img ? `<img src="${sc.img}" alt="">` : `<span>${online ? esc((sc && sc.note) || 'Waiting for screen') : 'Offline'}</span>`}</div>
    <div class="strip ${strip}"></div>
    <div class="info"><div class="nm"><span>${esc(s.name)}</span>
      ${p.locked && online ? '<span class="tag red">Locked</span>' : ''}${p.focus && online ? '<span class="tag amber">Focus</span>' : ''}
      ${recentAlert ? '<span class="tag red">Alert</span>' : ''}
      <span class="gr">${esc(shortGrade(s.grade))}</span></div>
    <div class="ur">${online ? esc(act.title || act.url || 'Online') : S.online[k] ? 'Last seen ' + esc(fmt(S.online[k])) : 'Not seen yet'}</div></div>`;
  el.querySelector('.pick').onclick = (e) => {
    e.stopPropagation();
    if (S.selected.has(k)) S.selected.delete(k); else S.selected.add(k);
    paintTile(k);
    refreshGrid(true);
  };
}

function paintRow(k) {
  const el = document.getElementById('t-' + k);
  if (!el) return;
  const s = student(k);
  const p = S.presence[k] || {};
  const sc = S.screens[k];
  const online = isOnline(k);
  const recentAlert = S.alerts.find((a) => a.student === k && a.ts && serverNow() - a.ts < 15 * 60 * 1000);
  const tabs = online ? list(p.tabs) : [];
  el.className = 'tile row' + (online ? '' : ' off') + (S.selected.has(k) ? ' sel' : '');
  el.innerHTML = `<input type="checkbox" class="pick" aria-label="Select ${esc(s.name)}" ${S.selected.has(k) ? 'checked' : ''}>
    <div class="row-who">
      <div class="mini">${online && sc && sc.img ? `<img src="${sc.img}" alt="">` : `<span>${online ? '' : 'Offline'}</span>`}</div>
      <div class="nm">${esc(s.name)}</div>
      <div class="ur">${online ? `${tabs.length} tab${tabs.length === 1 ? '' : 's'}${p.tabLimit ? ' of ' + p.tabLimit : ''}` : S.online[k] ? 'Last seen ' + esc(fmtTime(S.online[k])) : 'Not seen yet'}</div>
      <div>${p.locked && online ? '<span class="tag red">Locked</span> ' : ''}${p.focus && online ? '<span class="tag amber">Focus</span> ' : ''}${recentAlert ? '<span class="tag red">Alert</span>' : ''}</div>
    </div>
    <div class="row-tabs">${online ? (tabs.length ? tabs.map((t) => `<span class="tabchip${t.active ? ' active' : ''}" title="${esc(t.url)}">
        <img src="${t.favIconUrl ? esc(t.favIconUrl) : `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domainOf(t.url))}&sz=32`}" alt="">
        <span class="tt">${esc(t.title || domainOf(t.url) || t.url)}</span>
        <button class="x" data-close="${t.id}" aria-label="Close ${esc(t.title || 'tab')}">×</button></span>`).join('') : '<span class="hint">No tabs open.</span>') : ''}</div>`;
  el.querySelector('.pick').onclick = (e) => {
    e.stopPropagation();
    if (S.selected.has(k)) S.selected.delete(k); else S.selected.add(k);
    paintRow(k);
    refreshGrid(true);
  };
  el.querySelectorAll('[data-close]').forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    b.closest('.tabchip').classList.add('closing');
    sendCommand([k], { type: 'closeTab', tabId: Number(b.dataset.close) }, 'closeTab', s.email);
  }));
}

// Tell students' extensions someone is watching (they only send screenshots while this stays fresh).
function startViewer() {
  clearInterval(S.viewerTimer);
  const beat = () => {
    if (document.hidden) return;
    const upd = {};
    [...S.gridSubs.keys()].forEach((k) => (upd[`inbox/${k}/viewer`] = { ts: serverTimestamp(), hi: S.drawerKey === k, by: S.me.key }));
    if (S.drawerKey) upd[`inbox/${S.drawerKey}/viewer`] = { ts: serverTimestamp(), hi: true, by: S.me.key };
    if (Object.keys(upd).length) update(ref(db), upd).catch((e) => console.warn('viewer', e.message));
  };
  setTimeout(beat, 600);
  S.viewerTimer = setInterval(beat, 15000);
  S.viewerBeat = beat;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.viewerBeat) S.viewerBeat(); });

// ---------- teacher actions ----------
function setForAll(keys, field, value, action, label, detail = {}) {
  if (!keys.length) return toast('No students to apply this to.');
  const upd = {};
  keys.forEach((k) => (upd[`inbox/${k}/${field}`] = value));
  return update(ref(db), upd).then(() => {
    toast(`Done for ${keys.length} student${keys.length === 1 ? '' : 's'}. It reaches their Chromebooks within 15 seconds.`);
    audit(action, label, { count: keys.length, ...detail });
  }).catch((e) => toast('That didn’t go through: ' + esc(e.message)));
}

function sendCommand(keys, cmd, action, label) {
  if (!keys.length) return toast('No students to send this to.');
  const upd = {};
  keys.forEach((k) => {
    const id = push(ref(db, `inbox/${k}/cmds`)).key;
    upd[`inbox/${k}/cmds/${id}`] = { ...cmd, by: S.me.key, ts: serverTimestamp() };
  });
  return update(ref(db), upd).then(() => {
    if (cmd.type !== 'closeTab') toast(`Sent to ${keys.length} student${keys.length === 1 ? '' : 's'}.`);
    audit(action, label, { count: keys.length, ...cmd });
  }).catch((e) => toast('That didn’t go through: ' + esc(e.message)));
}

const countLine = (keys) => `${keys.length} student${keys.length === 1 ? '' : 's'}`;

function focusModal(keys, label) {
  const last = localStorage.getItem('am-focus') || 'classroom.google.com\ndocs.google.com\ndrive.google.com';
  modal(`<h3>Focus mode</h3><p class="hint">For ${countLine(keys)}. They can only open these sites until you end focus. School block policies still apply.</p>
    <label class="field" for="f-list">Allowed sites <span class="hint">one per line</span></label><textarea id="f-list">${esc(last)}</textarea>
    <label class="field" for="f-label">Name shown to students</label><input id="f-label" type="text" value="${esc(label)}">
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="f-go">Start focus mode</button></div>`,
  (m, close) => {
    m.querySelector('#f-go').onclick = () => {
      const allowed = domains(lines(m.querySelector('#f-list').value));
      if (!allowed.length) return toast('Add at least one site.');
      localStorage.setItem('am-focus', allowed.join('\n'));
      setForAll(keys, 'focus', { on: true, allowed, label: m.querySelector('#f-label').value, by: S.me.key, ts: serverTimestamp() }, 'start_focus', label, { allowed });
      close();
    };
  });
}

function openUrlModal(keys, label) {
  modal(`<h3>Open a site</h3><p class="hint">Opens in a new tab for ${countLine(keys)}.</p>
    <label class="field" for="o-url">Web address</label><input id="o-url" type="text" placeholder="classroom.google.com">
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="o-go">Open site</button></div>`,
  (m, close) => {
    m.querySelector('#o-go').onclick = () => {
      let url = m.querySelector('#o-url').value.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      sendCommand(keys, { type: 'openUrl', url }, 'open_url', label);
      close();
    };
  });
}

function messageModal(keys, label) {
  modal(`<h3>Send a message</h3><p class="hint">Pops up on the screens of ${countLine(keys)}.</p>
    <label class="field" for="m-text">Message</label><textarea id="m-text" maxlength="500" style="font-family:var(--body);font-size:15px"></textarea>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="m-go">Send message</button></div>`,
  (m, close) => {
    m.querySelector('#m-go').onclick = () => {
      const text = m.querySelector('#m-text').value.trim();
      if (!text) return;
      sendCommand(keys, { type: 'message', text, fromName: S.me.name }, 'message', label);
      close();
    };
  });
}

function lockModal(keys, label) {
  modal(`<h3>Lock screens</h3><p class="hint">Locks the screens of ${countLine(keys)} until you unlock them.</p>
    <label class="field" for="l-msg">Message on the lock screen</label><input id="l-msg" type="text" value="Eyes up front, please.">
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn danger" id="l-go">Lock screens</button></div>`,
  (m, close) => {
    m.querySelector('#l-go').onclick = () => {
      setForAll(keys, 'lock', { on: true, message: m.querySelector('#l-msg').value, by: S.me.key, ts: serverTimestamp() }, 'lock', label);
      close();
    };
  });
}

// ---------- student drawer ----------
function openDrawer(k) {
  if (!k) return;
  closeDrawer(true);
  S.drawerKey = k;
  S.drawerTab = 'screen';
  S.history = []; S.devSessions = []; S.studentAlerts = [];
  $('drawer').classList.remove('hidden');
  const subs = S.drawerSubs;
  if (!S.gridSubs.has(k)) {
    subs.push(onValue(ref(db, `presence/${k}`), (s) => { S.presence[k] = s.val(); renderDrawer(); }));
    subs.push(onValue(ref(db, `screens/${k}`), (s) => { S.screens[k] = s.val(); renderDrawer(); }));
  }
  if (!(k in S.online) || seesAll() || S.role === 'principal') {
    subs.push(onValue(ref(db, `online/${k}`), (s) => { S.online[k] = s.val(); renderDrawer(); }));
  }
  subs.push(onValue(query(ref(db, `history/${k}`), limitToLast(150)), (s) => {
    S.history = Object.values(s.val() || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0)); if (S.drawerTab === 'history') renderDrawer();
  }));
  subs.push(onValue(query(ref(db, `alerts/${k}`), limitToLast(30)), (s) => {
    S.studentAlerts = Object.values(s.val() || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0)); if (S.drawerTab === 'alerts') renderDrawer();
  }));
  if (isLead()) {
    subs.push(onValue(query(ref(db, 'deviceSessions'), orderByChild('student'), equalTo(k), limitToLast(20)), (s) => {
      S.devSessions = Object.values(s.val() || {}).sort((a, b) => (b.start || 0) - (a.start || 0)); if (S.drawerTab === 'devices') renderDrawer();
    }));
  }
  audit('view_student', student(k).email);
  renderDrawer();
  if (!S.viewerTimer) startViewer(); else S.viewerBeat && S.viewerBeat();
}

function closeDrawer(silent) {
  unsubAll(S.drawerSubs);
  const was = S.drawerKey;
  S.drawerKey = null;
  $('drawer').classList.add('hidden');
  if (was && !silent) update(ref(db), { [`inbox/${was}/viewer`]: { ts: serverTimestamp(), hi: false, by: S.me.key } }).catch(() => {});
  if (!S.view || (S.view.type !== 'grade' && S.view.type !== 'course')) clearInterval(S.viewerTimer), (S.viewerTimer = null);
}

function renderDrawer() {
  const k = S.drawerKey;
  if (!k) return;
  const s = student(k);
  const p = S.presence[k] || {};
  const sc = S.screens[k];
  const online = isOnline(k);
  const d = p.device || {};
  const tabs = list(p.tabs);
  const tabBtn = (id, label) => `<button data-tab="${id}" class="${S.drawerTab === id ? 'on' : ''}">${label}</button>`;
  let body = '';
  if (S.drawerTab === 'screen') {
    body = `<div class="toolrow">
        ${p.locked ? '<button class="btn" id="d-unlock">Unlock</button>' : '<button class="btn danger" id="d-lock">Lock screen…</button>'}
        <button class="btn" id="d-msg">Message…</button><button class="btn" id="d-open">Open a site…</button>
        ${p.focus ? '<button class="btn" id="d-unfocus">End focus</button>' : '<button class="btn" id="d-focus">Focus mode…</button>'}
      </div>
      <div class="big-shot">${online && sc && sc.img ? `<img src="${sc.img}" alt="Screen of ${esc(s.name)}">` : esc(online ? (sc && sc.note) || 'Loading live screen…' : 'Offline')}</div>
      <p class="hint">${online && sc && sc.ts ? 'Updated ' + esc(fmtTime(sc.ts)) + '. Refreshes every few seconds while this is open.' : ''}</p>
      <h3 style="font-family:var(--display);font-size:22px;margin:18px 0 8px">Open tabs</h3>
      <div class="list">${online && tabs.length ? tabs.map((t) => `<div class="item">
          ${t.favIconUrl ? `<img src="${esc(t.favIconUrl)}" alt="">` : ''}
          <div class="grow"><div class="t1">${t.active ? '<b>Showing: </b>' : ''}${esc(t.title || t.url)}</div><div class="t2">${esc(t.url)}</div></div>
          <button class="btn small" data-cmd="focusTab" data-tabid="${t.id}">Show</button>
          <button class="btn small" data-cmd="closeTab" data-tabid="${t.id}">Close tab</button></div>`).join('') : '<div class="item">No open tabs reported.</div>'}</div>`;
  } else if (S.drawerTab === 'history') {
    body = `<div class="list">${S.history.length ? S.history.map((h) => `<div class="item ${h.blocked ? 'blocked' : ''}">
        <span class="hint" style="width:64px">${esc(fmtTime(h.ts))}</span>
        <div class="grow"><div class="t1">${h.blocked ? '<b>Blocked</b>, ' + esc(h.policy || '') : esc(h.title || '')}</div><div class="t2">${esc(h.url)}</div></div>
        <span class="hint">${esc(h.serial || '')}</span></div>`).join('') : '<div class="item">No browsing history yet.</div>'}</div>`;
  } else if (S.drawerTab === 'alerts') {
    body = alertFeed(S.studentAlerts.map((a) => ({ ...a, student: k, name: s.name })));
  } else if (S.drawerTab === 'devices') {
    body = `<div class="list">${S.devSessions.length ? S.devSessions.map((x) => `<div class="item"><div class="grow">
        <div class="t1">Serial <b>${esc(x.serial || 'unknown')}</b>${x.assetId ? ', asset ' + esc(x.assetId) : ''}</div>
        <div class="t2">${esc(fmt(x.start))} to ${esc(fmt(x.lastSeen))}${x.location ? ', ' + esc(x.location) : ''}</div></div></div>`).join('') : '<div class="item">No device sessions yet.</div>'}</div>`;
  }
  $('drawer').innerHTML = `
    <div class="drawer-head">
      <div class="row1"><span class="jersey" style="color:var(--columbia);font-size:54px">${esc(shortGrade(s.grade))}</span>
        <div><h2>${esc(s.name)}</h2><div class="meta">${esc(s.email)}, ${online ? (p.idle && p.idle !== 'active' ? 'idle' : 'online') : 'offline'}${d.serial ? `, device ${esc(d.serial)}` : ''}</div></div>
        <button class="close" id="d-close">Close</button></div>
      <div class="tabs">${tabBtn('screen', 'Screen')}${tabBtn('history', 'Browsing history')}${tabBtn('alerts', 'Alerts')}${isLead() ? tabBtn('devices', 'Devices') : ''}</div>
    </div>
    <div class="drawer-body">${body}</div>`;
  $('d-close').onclick = () => closeDrawer();
  $('drawer').querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { S.drawerTab = b.dataset.tab; renderDrawer(); }));
  const one = [k];
  const lbl = s.email;
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('d-lock', () => lockModal(one, lbl));
  on('d-unlock', () => setForAll(one, 'lock', null, 'unlock', lbl));
  on('d-focus', () => focusModal(one, lbl));
  on('d-unfocus', () => setForAll(one, 'focus', null, 'end_focus', lbl));
  on('d-msg', () => messageModal(one, lbl));
  on('d-open', () => openUrlModal(one, lbl));
  $('drawer').querySelectorAll('[data-cmd]').forEach((b) => (b.onclick = () =>
    sendCommand(one, { type: b.dataset.cmd, tabId: Number(b.dataset.tabid) }, b.dataset.cmd, lbl)));
  wireFeed($('drawer'));
}

// ---------- web filtering ----------
const ACTION_LABEL = { block: 'Block these sites', allow: 'Always allow (whitelist)', allowOnly: 'Only allow these sites' };

function targetText(p) {
  const t = p.targets || { all: true };
  if (t.all) return 'All students';
  const parts = [];
  const gs = sortGrades(Object.keys(t.grades || {}));
  if (gs.length) parts.push('Grades ' + gs.join(', '));
  const cs = Object.keys(t.courses || {});
  if (cs.length) parts.push(cs.map((id) => (S.rosters[id] && S.rosters[id].name) || 'a class').join(', '));
  const ss = Object.keys(t.students || {});
  if (ss.length) parts.push(`${ss.length} student${ss.length === 1 ? '' : 's'}`);
  return parts.join('; ') || 'Nobody';
}

function gradePicks(name, selected) {
  return `<div class="grade-picks">${GRADE_ORDER.map((g) =>
    `<label><input type="checkbox" name="${name}" value="${g}" ${selected && selected[g] ? 'checked' : ''}><span>${g}</span></label>`).join('')}</div>`;
}
const pickedGrades = (root, name) => Object.fromEntries([...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => [i.value, true]));

function renderFiltering() {
  $('main').innerHTML = `
    <div class="page-head"><div><h1>Web filtering</h1><div class="sub">Changes reach Chromebooks within about 5 minutes.</div></div>
      <div class="actions"><button class="btn primary" id="p-new">New policy</button></div></div>
    <div class="panel"><h2>Policies</h2>
      <p class="hint">Rules are checked in this order: sign-in pages, then teacher focus mode, then <b>Always allow</b>, then <b>Block</b>, then <b>Only allow</b>. A whitelisted site wins over any block.</p>
      <div id="p-table"><div class="empty">Loading…</div></div></div>
    <div class="panel"><h2>Test a web address</h2>
      <div class="form-grid"><div><label class="field" for="t-url">Web address</label><input id="t-url" type="text" placeholder="coolmathgames.com"></div>
      <div><label class="field" for="t-who">Student <span class="hint">optional, uses their grade and classes</span></label><input id="t-who" type="email" placeholder="student@${esc(CONFIG.DOMAIN)}"></div>
      <div style="align-self:end"><button class="btn" id="t-go">Test address</button></div></div>
      <p id="t-out" style="margin-bottom:0"></p></div>`;
  $('p-new').onclick = () => policyModal(null, {});
  S.viewSubs.push(onValue(ref(db, 'policies'), (s) => {
    S.policies = s.val() || {};
    const rows = Object.entries(S.policies).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
    $('p-table').innerHTML = rows.length ? `<table class="data"><tr><th>On</th><th>Policy</th><th>Type</th><th>Applies to</th><th>Sites</th><th>When</th><th></th></tr>
      ${rows.map(([id, p]) => `<tr>
        <td><input type="checkbox" data-toggle="${esc(id)}" ${p.enabled !== false ? 'checked' : ''} aria-label="Turn ${esc(p.name)} on or off"></td>
        <td><b>${esc(p.name)}</b><div class="hint">Edited by ${esc(p.updatedBy || 'unknown')}</div></td><td>${esc(ACTION_LABEL[p.action] || p.action)}</td><td>${esc(targetText(p))}</td>
        <td>${list(p.domains).length} sites${list(p.keywords).length ? `, ${list(p.keywords).length} keywords` : ''}</td>
        <td>${p.schedule && p.schedule.enabled ? esc(list(p.schedule.days).map((d) => DAYS[d]).join(' ') + ', ' + p.schedule.start + '–' + p.schedule.end) : 'Always'}</td>
        <td style="white-space:nowrap"><button class="btn small" data-edit="${esc(id)}">Edit</button> <button class="btn small quiet" data-del="${esc(id)}">Delete</button></td></tr>`).join('')}</table>`
      : '<div class="empty">No policies yet. Create one to block or whitelist sites.</div>';
    $('p-table').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => policyModal(b.dataset.edit, S.policies[b.dataset.edit])));
    $('p-table').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const p = S.policies[b.dataset.del];
      if (!confirm(`Delete the policy "${p.name}"?`)) return;
      await set(ref(db, `policies/${b.dataset.del}`), null);
      await bumpRev();
      audit('policy_delete', p.name);
      toast('Policy deleted.');
    }));
    $('p-table').querySelectorAll('[data-toggle]').forEach((b) => (b.onchange = async () => {
      await update(ref(db, `policies/${b.dataset.toggle}`), { enabled: b.checked, updatedAt: serverTimestamp(), updatedBy: S.me.email });
      await bumpRev();
      audit(b.checked ? 'policy_enable' : 'policy_disable', S.policies[b.dataset.toggle].name);
    }));
  }));
  $('t-go').onclick = async () => {
    let url = $('t-url').value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const who = $('t-who').value.trim().toLowerCase();
    const k = who ? emailKey(who) : '__nobody__';
    const courses = who ? (await get(ref(db, `studentCourses/${k}`)).catch(() => null))?.val() || {} : {};
    const grade = who ? String((await get(ref(db, `studentGrades/${k}`)).catch(() => null))?.val() || '') : '';
    const active = activePolicies(S.policies, k, courses, new Date(), grade);
    const r = evaluate(url, { active, focus: null, essentials: list((S.config.client || {}).essentialDomains) });
    $('t-out').innerHTML = r.blocked
      ? `<span class="tag red">Blocked</span> by <b>${esc(r.policy || '')}</b>. ${esc(REASON_TEXT[r.reason] || '')}`
      : `<span class="tag green">Allowed</span> ${r.policy ? 'by <b>' + esc(r.policy) + '</b>' : ''} <span class="hint">${active.length} ${active.length === 1 ? 'policy applies' : 'policies apply'} right now${grade ? ' to this ' + esc(gradeLabel(grade)) + ' student' : ''}.</span>`;
  };
}

function policyModal(id, p) {
  const t = p.targets || { all: true };
  const sch = p.schedule || { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '15:00' };
  const days = list(sch.days).map(Number);
  const courses = Object.entries(S.rosters).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  modal(`<h3>${id ? 'Edit policy' : 'New policy'}</h3>
    <label class="field" for="e-name">Policy name</label><input id="e-name" type="text" value="${esc(p.name || '')}" placeholder="Block games">
    <label class="field" for="e-action">What it does</label><select id="e-action">
      ${Object.entries(ACTION_LABEL).map(([v, l]) => `<option value="${v}" ${(p.action || 'block') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <p class="hint" id="e-help"></p>
    <label class="field" for="e-domains">Sites <span class="hint">one per line; a site covers its subdomains, so roblox.com also blocks www.roblox.com</span></label>
    <textarea id="e-domains">${esc(list(p.domains).join('\n'))}</textarea>
    <div id="e-kw-wrap"><label class="field" for="e-kw">Blocked words <span class="hint">blocks any address containing the word</span></label>
    <textarea id="e-kw" style="min-height:60px">${esc(list(p.keywords).join('\n'))}</textarea></div>
    <label class="field">Who it applies to</label>
    <label class="check"><input type="radio" name="e-tgt" value="all" ${t.all ? 'checked' : ''}>All students</label>
    <label class="check"><input type="radio" name="e-tgt" value="some" ${t.all ? '' : 'checked'}>Specific grades, classes or students</label>
    <div id="e-some">
      <label class="field">Grade levels</label>${gradePicks('e-grade', t.grades)}
      <label class="field">Classes</label><div class="picklist">${courses.length ? courses.map(([cid, c]) => `<label class="check"><input type="checkbox" data-course="${esc(cid)}" ${t.courses && t.courses[cid] ? 'checked' : ''}>${esc(c.name)} <span class="hint">${esc(c.section || '')}</span></label>`).join('') : '<span class="hint">No classes synced yet.</span>'}</div>
      <label class="field" for="e-students">Students <span class="hint">emails, one per line</span></label><textarea id="e-students" style="min-height:60px">${esc(mapToEmails(t.students))}</textarea>
    </div>
    <label class="field" for="e-except">Never apply to <span class="hint">student emails, one per line</span></label><textarea id="e-except" style="min-height:50px">${esc(mapToEmails(p.except))}</textarea>
    <label class="field">When</label>
    <label class="check"><input type="checkbox" id="e-sch" ${sch.enabled ? 'checked' : ''}>Only during these times</label><br>
    ${DAYS.map((d, i) => `<label class="check"><input type="checkbox" id="e-day${i}" ${days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}
    <div class="form-grid"><div><label class="field" for="e-start">From</label><input type="time" id="e-start" value="${esc(sch.start)}"></div><div><label class="field" for="e-end">Until</label><input type="time" id="e-end" value="${esc(sch.end)}"></div></div>
    <label class="check" style="margin-top:14px"><input type="checkbox" id="e-enabled" ${p.enabled !== false ? 'checked' : ''}>Policy is on</label>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="e-save">Save policy</button></div>`,
  (m, close) => {
    const help = {
      block: 'Students can’t visit these sites, or any address containing a blocked word.',
      allow: 'These sites are always allowed, even if another policy blocks them.',
      allowOnly: 'Students can only visit these sites, plus whitelisted and sign-in sites.',
    };
    const sync = () => {
      const a = m.querySelector('#e-action').value;
      m.querySelector('#e-help').textContent = help[a];
      m.querySelector('#e-kw-wrap').style.display = a === 'block' ? '' : 'none';
      m.querySelector('#e-some').style.display = m.querySelector('input[name=e-tgt]:checked').value === 'some' ? '' : 'none';
    };
    m.querySelectorAll('#e-action, input[name=e-tgt]').forEach((el) => (el.onchange = sync));
    sync();
    m.querySelector('#e-save').onclick = async () => {
      const name = m.querySelector('#e-name').value.trim();
      const action = m.querySelector('#e-action').value;
      const doms = domains(lines(m.querySelector('#e-domains').value));
      const kws = action === 'block' ? keywords(lines(m.querySelector('#e-kw').value)) : [];
      if (!name) return toast('Give the policy a name.');
      if (action !== 'allowOnly' && !doms.length && !kws.length) return toast('Add at least one site or word.');
      const all = m.querySelector('input[name=e-tgt]:checked').value === 'all';
      const targets = all ? { all: true } : {
        all: false,
        grades: pickedGrades(m, 'e-grade'),
        courses: Object.fromEntries([...m.querySelectorAll('[data-course]:checked')].map((c) => [c.dataset.course, true])),
        students: emailsToMap(m.querySelector('#e-students').value),
      };
      const policy = {
        name, action, domains: doms, keywords: kws, targets,
        except: emailsToMap(m.querySelector('#e-except').value),
        schedule: { enabled: m.querySelector('#e-sch').checked, days: DAYS.map((_, i) => i).filter((i) => m.querySelector('#e-day' + i).checked), start: m.querySelector('#e-start').value, end: m.querySelector('#e-end').value },
        enabled: m.querySelector('#e-enabled').checked,
        updatedAt: serverTimestamp(), updatedBy: S.me.email,
      };
      const pid = id || push(ref(db, 'policies')).key;
      try {
        await set(ref(db, `policies/${pid}`), policy);
        await bumpRev();
        audit(id ? 'policy_edit' : 'policy_create', name, { action, sites: doms.length });
        toast('Policy saved.');
        close();
      } catch (e) { toast('Policy not saved: ' + esc(e.message)); }
    };
  });
}

// ---------- reports ----------
function gradeFilterSelect(id) {
  const gs = S.role === 'principal' ? sortGrades(myGrades()) : GRADE_ORDER;
  return `<select id="${id}" aria-label="Grade"><option value="">All grades</option>${gs.map((g) => `<option value="${g}">${esc(gradeLabel(g))}</option>`).join('')}</select>`;
}

function renderReports() {
  let tab = 'alerts';
  let rowsByTab = { alerts: [], blocked: [], activity: [] };
  $('main').innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><div class="sub">${S.role === 'principal' ? 'Students in your grade levels.' : 'All students.'}</div></div>
      <div class="actions"><button class="btn" id="r-csv">Download CSV</button></div></div>
    <div class="subtabs"><button data-t="alerts" class="on">Tamper alerts</button><button data-t="blocked">Blocked sites</button><button data-t="activity">Staff activity</button></div>
    <div class="toolrow">${gradeFilterSelect('r-grade')}<input id="r-q" type="search" placeholder="Filter by name, site or action"></div>
    <div id="r-table"><div class="empty">Loading…</div></div>`;
  const gradeOf = (r) => r.grade || (S.idx.get(r.student) || {}).grade || '';
  const visible = (r) => S.role !== 'principal' || !r.student || S.idx.has(r.student);
  const draw = () => {
    const g = $('r-grade').value;
    const q = $('r-q').value.toLowerCase();
    let rows = rowsByTab[tab].filter(visible);
    if (g && tab !== 'activity') rows = rows.filter((r) => gradeOf(r) === g);
    if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
    S.reportRows = rows;
    const name = (r) => `<a href="#" data-student="${esc(r.student)}">${esc(r.name || student(r.student).name || r.email)}</a>`;
    let html = '';
    if (!rows.length) html = '<div class="empty">Nothing to show.</div>';
    else if (tab === 'alerts') html = `<table class="data"><tr><th>When</th><th>Student</th><th>Grade</th><th>What happened</th><th>Device</th></tr>${rows.map((r) =>
      `<tr><td>${esc(fmt(r.ts))}</td><td>${name(r)}</td><td>${esc(shortGrade(gradeOf(r)))}</td><td>${esc(r.detail || r.type)}</td><td>${esc(r.serial || '')}</td></tr>`).join('')}</table>`;
    else if (tab === 'blocked') html = `<table class="data"><tr><th>When</th><th>Student</th><th>Grade</th><th>Site</th><th>Blocked by</th><th>Device</th></tr>${rows.map((r) =>
      `<tr><td>${esc(fmt(r.ts))}</td><td>${name(r)}</td><td>${esc(shortGrade(gradeOf(r)))}</td><td class="wrap">${esc(r.url)}</td><td>${esc(r.policy || r.reason)}</td><td>${esc(r.serial || '')}</td></tr>`).join('')}</table>`;
    else html = `<table class="data"><tr><th>When</th><th>Staff</th><th>Action</th><th>Students or class</th><th>Details</th></tr>${rows.map((r) =>
      `<tr><td>${esc(fmt(r.ts))}</td><td>${esc(r.email)}</td><td>${esc(String(r.action || '').replace(/_/g, ' '))}</td><td>${esc(r.target)}</td><td class="wrap hint">${esc(Object.entries(r.detail || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : v}`).join('; '))}</td></tr>`).join('')}</table>`;
    $('r-table').innerHTML = html;
    wireFeed($('r-table'));
  };
  const feed = (path, key) => S.viewSubs.push(onValue(query(ref(db, path), limitToLast(400)), (s) => {
    rowsByTab[key] = Object.values(s.val() || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (tab === key) draw();
  }));
  feed('alertLog', 'alerts'); feed('blockLog', 'blocked'); feed('audit', 'activity');
  $('main').querySelectorAll('.subtabs button').forEach((b) => (b.onclick = () => {
    tab = b.dataset.t;
    $('main').querySelectorAll('.subtabs button').forEach((x) => x.classList.toggle('on', x === b));
    draw();
  }));
  $('r-grade').onchange = draw;
  $('r-q').oninput = draw;
  $('r-csv').onclick = () => downloadCsv(`adena-monitor-${tab}.csv`, S.reportRows || []);
}

function downloadCsv(name, rows) {
  if (!rows.length) return toast('Nothing to download.');
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => '"' + String(v && typeof v === 'object' ? JSON.stringify(v) : v ?? '').replace(/"/g, '""') + '"';
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(/^(ts|start|lastSeen)$/.test(c) && r[c] ? new Date(r[c]).toISOString() : r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
}

// ---------- devices ----------
function renderDevices() {
  $('main').innerHTML = `
    <div class="page-head"><div><h1>Devices</h1><div class="sub">Which Chromebook each student signed in on, by serial number.</div></div>
      <div class="actions"><button class="btn" id="dv-csv">Download CSV</button></div></div>
    <div class="toolrow"><input id="dv-q" type="search" placeholder="Serial number or student email" style="min-width:320px">
      <button class="btn primary" id="dv-go">Look up</button><button class="btn quiet" id="dv-recent">Show recent sign-ins</button></div>
    <div id="dv-table"><div class="empty">Loading…</div></div>`;
  let rows = [];
  let unsub = null;
  const show = (q) => {
    unsub && unsub();
    $('dv-table').innerHTML = '<div class="empty">Loading…</div>';
    unsub = onValue(q, (s) => {
      rows = Object.values(s.val() || {}).filter((r) => S.role !== 'principal' || S.idx.has(r.student))
        .sort((a, b) => (b.start || 0) - (a.start || 0));
      $('dv-table').innerHTML = rows.length ? `<table class="data"><tr><th>Signed in</th><th>Last seen</th><th>Student</th><th>Grade</th><th>Serial</th><th>Asset ID</th><th>Location</th></tr>
        ${rows.map((r) => `<tr><td>${esc(fmt(r.start))}</td><td>${esc(fmt(r.lastSeen))}</td><td><a href="#" data-student="${esc(r.student)}">${esc(r.name || r.email)}</a></td>
        <td>${esc(shortGrade(student(r.student).grade))}</td><td><b>${esc(r.serial || 'unknown')}</b></td><td>${esc(r.assetId || '')}</td><td>${esc(r.location || '')}</td></tr>`).join('')}</table>`
        : '<div class="empty">No sign-ins found.</div>';
      wireFeed($('dv-table'));
    }, (e) => ($('dv-table').innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  };
  S.viewSubs.push(() => unsub && unsub());
  const recent = () => show(query(ref(db, 'deviceSessions'), limitToLast(200)));
  $('dv-recent').onclick = recent;
  $('dv-go').onclick = () => {
    const q = $('dv-q').value.trim();
    if (!q) return recent();
    if (q.includes('@')) show(query(ref(db, 'deviceSessions'), orderByChild('student'), equalTo(emailKey(q)), limitToLast(200)));
    else show(query(ref(db, 'deviceSessions'), orderByChild('serial'), equalTo(q.toUpperCase()), limitToLast(200)));
  };
  $('dv-q').onkeydown = (e) => { if (e.key === 'Enter') $('dv-go').click(); };
  $('dv-csv').onclick = () => downloadCsv('adena-monitor-devices.csv', rows);
  recent();
}

// ---------- users ----------
function renderUsers() {
  $('main').innerHTML = `
    <div class="page-head"><div><h1>Users</h1><div class="sub">Google Classroom teachers get Teacher access automatically. Add people here to make them a principal or admin, give someone extra classes, or switch off access.</div></div>
      <div class="actions"><button class="btn primary" id="u-new">Add user</button></div></div>
    <div class="toolrow"><input id="u-q" type="search" placeholder="Filter by name or email"></div>
    <div id="u-table"><div class="empty">Loading…</div></div>
    <p class="hint">Class changes take effect at the next hourly roster sync. Role and grade changes take effect right away.</p>`;
  let users = {};
  const draw = () => {
    const q = $('u-q').value.toLowerCase();
    const legacy = Object.keys(S.config.admins || {}).filter((k) => !users[k]).map((k) => [k, { email: keyToEmail(k), role: 'admin', legacy: true }]);
    const rows = [...Object.entries(users), ...legacy]
      .filter(([, u]) => !q || (u.email || '').includes(q) || (u.name || '').toLowerCase().includes(q))
      .sort((a, b) => ['admin', 'principal', 'teacher'].indexOf(a[1].role) - ['admin', 'principal', 'teacher'].indexOf(b[1].role) || (a[1].name || a[1].email).localeCompare(b[1].name || b[1].email));
    $('u-table').innerHTML = rows.length ? `<table class="data"><tr><th>Name</th><th>Role</th><th>Grade levels</th><th>Extra classes</th><th>Access</th><th></th></tr>
      ${rows.map(([k, u]) => `<tr><td><b>${esc(u.name || u.email)}</b><div class="hint">${esc(u.email)}</div></td>
        <td><span class="tag ${u.role === 'admin' ? 'blue' : u.role === 'principal' ? 'amber' : 'grey'}">${esc(ROLE_LABEL[u.role] || u.role)}</span>${u.legacy ? '<div class="hint">Set up at install</div>' : ''}</td>
        <td>${u.role === 'principal' ? esc(sortGrades(Object.keys(u.grades || {})).join(', ') || 'None yet') : u.role === 'admin' ? 'All' : ''}</td>
        <td>${Object.keys(u.courses || {}).map((c) => esc((S.rosters[c] && S.rosters[c].name) || 'Class')).join(', ')}</td>
        <td>${u.active === false ? '<span class="tag red">Off</span>' : '<span class="tag green">On</span>'}</td>
        <td style="white-space:nowrap"><button class="btn small" data-edit="${esc(k)}">Edit</button>${u.legacy ? '' : ` <button class="btn small quiet" data-del="${esc(k)}">Remove</button>`}</td></tr>`).join('')}</table>`
      : '<div class="empty">No users added yet. Classroom teachers already have Teacher access.</div>';
    $('u-table').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => userModal(b.dataset.edit, users[b.dataset.edit] || { email: keyToEmail(b.dataset.edit), role: 'admin' })));
    $('u-table').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const u = users[b.dataset.del];
      if (b.dataset.del === S.me.key) return toast('You can’t remove yourself.');
      if (!confirm(`Remove ${u.name || u.email}? If they teach in Google Classroom they keep Teacher access to their own classes.`)) return;
      await set(ref(db, `users/${b.dataset.del}`), null);
      audit('user_remove', u.email);
      toast('User removed.');
    }));
  };
  S.viewSubs.push(onValue(ref(db, 'users'), (s) => { users = s.val() || {}; draw(); }));
  $('u-q').oninput = draw;
  $('u-new').onclick = () => userModal(null, { role: 'teacher', active: true });
}

function userModal(key, u) {
  const courses = Object.entries(S.rosters).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  const roleCard = (v, title, desc) => `<label class="radio-card"><input type="radio" name="u-role" value="${v}" ${u.role === v ? 'checked' : ''}><span><b>${title}</b><span class="hint">${desc}</span></span></label>`;
  modal(`<h3>${key ? 'Edit user' : 'Add user'}</h3>
    <div class="form-grid" style="grid-template-columns:1fr 1fr"><div><label class="field" for="u-email">School email</label><input id="u-email" type="email" value="${esc(u.email || '')}" ${key ? 'disabled' : ''} placeholder="name@${esc(CONFIG.DOMAIN)}"></div>
    <div><label class="field" for="u-name">Name</label><input id="u-name" type="text" value="${esc(u.name || '')}"></div></div>
    <label class="field">Role</label>
    ${roleCard('teacher', 'Teacher', 'Sees and controls students in their Google Classroom classes, plus any extra classes below.')}
    ${roleCard('principal', 'Principal', 'Sees and controls every student in their grade levels. Gets tamper alerts, reports, device lookups and web filtering.')}
    ${roleCard('admin', 'Admin', 'Everything, including users and settings.')}
    <div id="u-grades-wrap"><label class="field">Grade levels</label>${gradePicks('u-grade', u.grades)}</div>
    <div id="u-courses-wrap"><label class="field" for="u-cq">Extra classes <span class="hint">for subs, aides and co-teachers</span></label>
      <input id="u-cq" type="search" placeholder="Filter classes"><div class="picklist" id="u-courses" style="margin-top:6px">${courses.map(([cid, c]) =>
        `<label class="check" data-name="${esc((c.name + ' ' + (c.section || '')).toLowerCase())}"><input type="checkbox" data-course="${esc(cid)}" ${u.courses && u.courses[cid] ? 'checked' : ''}>${esc(c.name)} <span class="hint">${esc(c.section || '')}</span></label>`).join('')}</div></div>
    <label class="check" style="margin-top:14px"><input type="checkbox" id="u-active" ${u.active !== false ? 'checked' : ''}>Has access to ${esc(CONFIG.PRODUCT_NAME)}</label>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="u-save">${key ? 'Save changes' : 'Add user'}</button></div>`,
  (m, close) => {
    const sync = () => {
      const r = (m.querySelector('input[name=u-role]:checked') || {}).value;
      m.querySelector('#u-grades-wrap').style.display = r === 'principal' ? '' : 'none';
      m.querySelector('#u-courses-wrap').style.display = r === 'teacher' ? '' : 'none';
    };
    m.querySelectorAll('input[name=u-role]').forEach((r) => (r.onchange = sync));
    sync();
    m.querySelector('#u-cq').oninput = (e) => {
      const q = e.target.value.toLowerCase();
      m.querySelectorAll('#u-courses label').forEach((l) => (l.style.display = !q || l.dataset.name.includes(q) ? '' : 'none'));
    };
    m.querySelector('#u-save').onclick = async () => {
      const email = (key ? u.email : m.querySelector('#u-email').value).trim().toLowerCase();
      if (!email.endsWith('@' + CONFIG.DOMAIN)) return toast(`Use an @${CONFIG.DOMAIN} email.`);
      const role = (m.querySelector('input[name=u-role]:checked') || {}).value;
      if (!role) return toast('Pick a role.');
      const k = emailKey(email);
      const active = m.querySelector('#u-active').checked;
      if (k === S.me.key && (role !== 'admin' || !active)) return toast('You can’t remove your own admin access.');
      const rec = {
        email, name: m.querySelector('#u-name').value.trim(), role, active,
        grades: role === 'principal' ? pickedGrades(m, 'u-grade') : {},
        courses: role === 'teacher' ? Object.fromEntries([...m.querySelectorAll('[data-course]:checked')].map((c) => [c.dataset.course, true])) : {},
        updatedAt: serverTimestamp(), updatedBy: S.me.email,
      };
      try {
        await set(ref(db, `users/${k}`), rec);
        audit(key ? 'user_edit' : 'user_add', email, { role, grades: Object.keys(rec.grades) });
        toast(key ? 'Changes saved.' : 'User added.');
        close();
      } catch (e) { toast('User not saved: ' + esc(e.message)); }
    };
  });
}

// ---------- settings ----------
function renderSettings() {
  const c = S.config;
  const cl = { ...(c.client || {}) };
  const sch = cl.schedule || { enabled: false, days: [1, 2, 3, 4, 5], start: '07:30', end: '15:30' };
  const days = list(sch.days).map(Number);
  const num = (id, label, val, hint = '') => `<div><label class="field" for="${id}">${label} <span class="hint">${hint}</span></label><input id="${id}" type="number" step="any" value="${esc(val)}"></div>`;
  const chk = (id, label, on) => `<label class="check"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}>${label}</label>`;
  const radio = (val, title, desc) => `<label class="radio-card"><input type="radio" name="mode" value="${val}" ${mode() === val ? 'checked' : ''}><span><b>${title}</b><span class="hint">${desc}</span></span></label>`;
  $('main').innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Roster last synced ${c.lastRosterSync ? esc(fmt(c.lastRosterSync)) + ` (${c.lastRosterSyncCourses || 0} classes)` : 'never'}.</div></div>
      <div class="actions"><button class="btn primary" id="s-save">Save settings</button></div></div>
    <div class="panel"><h2>What teachers can see</h2>
      ${radio('own_classes', 'Their own classes', 'Teachers see students in their Google Classroom classes and any extra classes assigned on the Users page.')}
      ${radio('any_student', 'Any student', 'Every teacher can find and view any student.')}
      ${radio('admins_only', 'Nothing', 'Only principals and admins can use the dashboard.')}</div>
    <div class="panel"><h2>Monitoring hours</h2>
      <p class="hint">Outside these hours, screens, tabs and history aren’t collected and teacher controls don’t work. Uses each Chromebook’s clock.</p>
      ${chk('s-sch', 'Only monitor during these hours', sch.enabled)}<br>
      ${DAYS.map((d, i) => chk('s-day' + i, d, days.includes(i))).join('')}
      <div class="form-grid"><div><label class="field" for="s-start">From</label><input id="s-start" type="time" value="${esc(sch.start)}"></div><div><label class="field" for="s-end">Until</label><input id="s-end" type="time" value="${esc(sch.end)}"></div></div></div>
    <div class="panel"><h2>Grade levels from Google Admin</h2>
      <p class="hint">Each student’s grade comes from their organizational unit. Fix any that were read wrong, or set one to “Not students”. Changes apply at the next hourly sync.</p>
      <div id="s-ous"><div class="empty">Loading…</div></div></div>
    <div class="panel"><h2>Screens and data</h2>
      <div class="form-grid">${num('s-shot', 'Thumbnail every', cl.screenshotSec ?? 15, 'seconds')}${num('s-live', 'Enlarged screen every', cl.liveScreenshotSec ?? 3, 'seconds')}${num('s-q', 'Image quality', cl.jpegQuality ?? 0.45, '0.1 to 0.9')}</div>
      <div class="form-grid">${num('s-tw', 'Thumbnail width', cl.thumbWidth ?? 320, 'pixels')}${num('s-lw', 'Enlarged width', cl.liveWidth ?? 1280, 'pixels')}${num('s-ret', 'Keep browsing history', cl.historyRetentionDays ?? 30, 'days')}</div>
      <div class="form-grid">${num('s-hb', 'Status update every', cl.heartbeatSec ?? 15, 'seconds')}${num('s-poll', 'Check for teacher actions every', cl.inboxPollSec ?? 15, 'seconds')}<div></div></div>
      <div style="margin-top:12px">${chk('s-ind', 'Show students a LIVE badge while they’re being viewed', cl.showViewingIndicator !== false)}<br>
      ${chk('s-hist', 'Keep browsing history', cl.logHistory !== false)}<br>
      ${chk('s-fa', 'Filter websites outside monitoring hours too', cl.filterAlways !== false)}<br>
      ${chk('s-ext', 'Close the Chrome extensions page and send a tamper alert', cl.blockExtensionsPage !== false)}</div>
      <label class="field" for="s-ess">Always reachable <span class="hint">sign-in pages, never blocked even in focus mode</span></label>
      <textarea id="s-ess">${esc(list(cl.essentialDomains).join('\n'))}</textarea></div>`;
  const overrides = Object.fromEntries(list(c.gradeMap).map((m) => [m.ou, m.grade]));
  S.viewSubs.push(onValue(ref(db, 'meta/ouSummary'), (s) => {
    const rows = list(s.val()).sort((a, b) => a.ou.localeCompare(b.ou));
    $('s-ous').innerHTML = rows.length ? `<table class="data"><tr><th>Organizational unit</th><th>People</th><th>Grade</th></tr>${rows.map((r) => {
      const cur = r.ou in overrides ? overrides[r.ou] : r.grade;
      return `<tr><td>${esc(r.ou)}</td><td>${r.count}</td><td><select data-ou="${esc(r.ou)}" data-detected="${esc(r.grade)}" style="width:auto">
        <option value="" ${!cur ? 'selected' : ''}>Not students</option>${GRADE_ORDER.map((g) => `<option value="${g}" ${cur === g ? 'selected' : ''}>${esc(gradeLabel(g))}</option>`).join('')}</select></td></tr>`;
    }).join('')}</table>` : '<div class="empty">Shows up after the next roster sync.</div>';
  }));
  $('s-save').onclick = async () => {
    const n = (id, d) => { const v = Number($(id).value); return Number.isFinite(v) && v > 0 ? v : d; };
    const client = {
      ...cl,
      schedule: { enabled: $('s-sch').checked, days: DAYS.map((_, i) => i).filter((i) => $('s-day' + i).checked), start: $('s-start').value, end: $('s-end').value },
      screenshotSec: n('s-shot', 15), liveScreenshotSec: n('s-live', 3), jpegQuality: Math.min(0.9, n('s-q', 0.45)),
      thumbWidth: n('s-tw', 320), liveWidth: n('s-lw', 1280), historyRetentionDays: n('s-ret', 30),
      heartbeatSec: n('s-hb', 15), inboxPollSec: Math.max(0, Number($('s-poll').value) || 0),
      showViewingIndicator: $('s-ind').checked, logHistory: $('s-hist').checked, filterAlways: $('s-fa').checked,
      blockExtensionsPage: $('s-ext').checked, essentialDomains: domains(lines($('s-ess').value)),
    };
    const gradeMap = [...document.querySelectorAll('#s-ous select[data-ou]')]
      .filter((sel) => sel.value !== sel.dataset.detected || sel.dataset.ou in overrides)
      .map((sel) => ({ ou: sel.dataset.ou, grade: sel.value }));
    const accessMode = (document.querySelector('input[name=mode]:checked') || {}).value || 'own_classes';
    try {
      await update(ref(db, 'config'), { accessMode, client, gradeMap });
      await bumpRev();
      audit('settings', 'config', { accessMode });
      toast('Settings saved.');
    } catch (e) { toast('Settings not saved: ' + esc(e.message)); }
  };
}
