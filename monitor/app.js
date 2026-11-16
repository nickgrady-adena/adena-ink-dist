// Adena Monitor — staff dashboard.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getDatabase, ref, onValue, get, set, update, push, serverTimestamp, query, limitToLast, orderByChild, equalTo,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { CONFIG } from './config.js';
import { emailKey, keyToEmail, activePolicies, evaluate, domains, keywords, list, REASON_TEXT } from './filter-core.js';

const app = initializeApp(CONFIG.firebase);
const auth = getAuth(app);
const db = getDatabase(app);
const $ = (id) => document.getElementById(id);

const S = {
  me: null, config: {}, isAdmin: false, isStaff: false, serverOffset: 0,
  courses: {}, courseSubs: [], courseSig: '',
  view: null, viewSubs: [], students: [], presence: {}, screens: {},
  selected: null, drawerSubs: [], viewerTimer: null,
};

// ---------- utils ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const serverNow = () => Date.now() + S.serverOffset;
const fmt = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
const lines = (t) => String(t || '').split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
const emailsToMap = (t) => Object.fromEntries(lines(t).map((e) => [emailKey(e), true]));
const mapToEmails = (m) => Object.keys(m || {}).map(keyToEmail).join('\n');
const unsubAll = (arr) => { arr.forEach((u) => { try { u(); } catch {} }); arr.length = 0; };
const mode = () => S.config.accessMode || 'own_classes';
const canBrowseAll = () => S.isAdmin || (mode() === 'any_student' && S.isStaff);
const canUse = () => S.isAdmin || (mode() !== 'admins_only' && S.isStaff);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), 3000);
}

function modal(html, onMount) {
  $('modal-card').innerHTML = html;
  $('modal').classList.remove('hidden');
  const close = () => $('modal').classList.add('hidden');
  $('modal-card').querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  onMount && onMount($('modal-card'), close);
}

// Tells every student extension to re-download settings/policies on its next check.
function bumpRev() {
  return set(ref(db, 'meta/rev'), serverTimestamp()).catch(() => {});
}

function audit(action, target, detail = {}) {
  push(ref(db, 'audit'), {
    by: S.me.key, email: S.me.email, action, target: target || '', detail, ts: serverTimestamp(),
  }).catch(() => {});
}

function isOnline(p) {
  return !!(p && p.online && p.lastSeen && serverNow() - p.lastSeen < 90000);
}

// ---------- auth ----------
document.title = CONFIG.PRODUCT_NAME;
$('signin-title').textContent = CONFIG.PRODUCT_NAME;
$('brand-name').textContent = CONFIG.PRODUCT_NAME;
$('signin-btn').onclick = async () => {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: CONFIG.DOMAIN, prompt: 'select_account' });
  try { await signInWithPopup(auth, provider); } catch (e) { $('signin-err').textContent = e.message; }
};
$('signout').onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    $('app').classList.add('hidden');
    $('signin').classList.remove('hidden');
    return;
  }
  const email = (user.email || '').toLowerCase();
  if (!email.endsWith('@' + CONFIG.DOMAIN)) {
    $('signin-err').textContent = `Please sign in with your @${CONFIG.DOMAIN} account.`;
    await signOut(auth);
    return;
  }
  S.me = { email, key: emailKey(email), name: user.displayName || email };
  $('signin').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('me').textContent = S.me.email;
  onValue(ref(db, '.info/serverTimeOffset'), (s) => (S.serverOffset = s.val() || 0));
  const staffSnap = await get(ref(db, `staff/${S.me.key}`)).catch(() => null);
  const isClassroomTeacher = !!(staffSnap && staffSnap.val());
  onValue(ref(db, 'config'), (snap) => {
    S.config = snap.val() || {};
    S.isAdmin = !!(S.config.admins && S.config.admins[S.me.key]);
    S.isStaff = isClassroomTeacher || S.isAdmin || !!(S.config.extraStaff && S.config.extraStaff[S.me.key]);
    loadCourses();
  }, (err) => { $('main').innerHTML = `<div class="empty">Could not load settings: ${esc(err.message)}</div>`; });
});

// ---------- courses ----------
function loadCourses() {
  const sig = [mode(), S.isAdmin, S.isStaff].join('|');
  if (sig === S.courseSig) { renderSide(); return; }
  S.courseSig = sig;
  unsubAll(S.courseSubs);
  S.courses = {};
  if (!canUse()) { renderSide(); showHome(); return; }
  if (canBrowseAll()) {
    S.courseSubs.push(onValue(ref(db, 'rosters'), (s) => { S.courses = s.val() || {}; renderSide(); }));
  } else {
    const inner = [];
    S.courseSubs.push(onValue(ref(db, `teacherCourses/${S.me.key}`), (s) => {
      unsubAll(inner);
      S.courses = {};
      Object.keys(s.val() || {}).forEach((cid) => {
        inner.push(onValue(ref(db, `rosters/${cid}`), (r) => {
          if (r.val()) S.courses[cid] = r.val(); else delete S.courses[cid];
          renderSide();
        }));
      });
      renderSide();
    }));
    S.courseSubs.push(() => unsubAll(inner));
  }
  renderSide();
  if (!S.view) showHome();
}

function renderSide() {
  const v = S.view || {};
  const a = (type, id, label, sub = '') =>
    `<a data-type="${type}" data-id="${esc(id || '')}" class="${v.type === type && (v.id || '') === (id || '') ? 'active' : ''}">${esc(label)}${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</a>`;
  let html = '';
  if (!canUse()) {
    html = '<div class="empty">You do not have access.</div>';
  } else {
    html += '<h4>Monitor</h4>';
    if (canBrowseAll()) html += a('all', '', 'All online students');
    const courses = Object.entries(S.courses).sort((x, y) => (x[1].name || '').localeCompare(y[1].name || ''));
    html += courses.length ? '' : '<div class="sub" style="padding:6px 16px">No classes found yet.</div>';
    html += courses.map(([id, c]) => a('course', id, c.name || id, [c.section, `${Object.keys(c.students || {}).length} students`].filter(Boolean).join(' · '))).join('');
    if (S.isAdmin) {
      html += '<h4>Admin</h4>' + a('filtering', '', 'Web filtering') + a('devices', '', 'Devices') + a('audit', '', 'Activity log') + a('settings', '', 'Settings');
    }
  }
  $('side').innerHTML = html;
  $('side').querySelectorAll('a').forEach((el) => (el.onclick = () => openView({ type: el.dataset.type, id: el.dataset.id })));
}

function showHome() {
  S.view = null;
  const msg = !canUse()
    ? `${esc(CONFIG.PRODUCT_NAME)} is currently limited to administrators. Ask an admin if you need access.`
    : 'Pick a class on the left to see your students’ screens.';
  $('main').innerHTML = `<div class="empty">${msg}</div>`;
}

function openView(view) {
  unsubAll(S.viewSubs);
  closeDrawer();
  clearInterval(S.viewerTimer);
  S.view = view;
  S.students = [];
  S.presence = {};
  S.screens = {};
  renderSide();
  if (view.type === 'course') openCourse(view.id);
  else if (view.type === 'all') openAll();
  else if (view.type === 'settings') renderSettings();
  else if (view.type === 'filtering') renderFiltering();
  else if (view.type === 'devices') renderDevices();
  else if (view.type === 'audit') renderAudit();
}

// ---------- monitoring views ----------
function openCourse(cid) {
  const c = S.courses[cid] || {};
  S.students = Object.entries(c.students || {})
    .map(([k, v]) => ({ key: k, email: v.e || keyToEmail(k), name: v.n || keyToEmail(k) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  renderMonitor(c.name || 'Class', [c.section, c.room].filter(Boolean).join(' · '));
  S.students.forEach((st) => {
    S.viewSubs.push(onValue(ref(db, `presence/${st.key}`), (s) => { S.presence[st.key] = s.val(); updateTile(st.key); updateCounts(); }));
    S.viewSubs.push(onValue(ref(db, `screens/${st.key}`), (s) => { S.screens[st.key] = s.val(); updateTile(st.key); }));
  });
  audit('view_class', c.name || cid, { students: S.students.length });
  startViewer();
}

function openAll() {
  renderMonitor('All online students', 'Everyone currently online');
  const screenSubs = {};
  S.viewSubs.push(onValue(ref(db, 'presence'), (s) => {
    const all = s.val() || {};
    S.presence = all;
    const online = Object.entries(all).filter(([, p]) => isOnline(p))
      .map(([k, p]) => ({ key: k, email: p.email || keyToEmail(k), name: p.name || p.email || keyToEmail(k) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const sig = online.map((x) => x.key).join(',');
    if (sig !== S.students.map((x) => x.key).join(',')) {
      S.students = online;
      // Live screenshots for the first 60 online students only (bandwidth).
      const want = new Set(online.slice(0, 60).map((x) => x.key));
      Object.keys(screenSubs).forEach((k) => { if (!want.has(k)) { screenSubs[k](); delete screenSubs[k]; delete S.screens[k]; } });
      want.forEach((k) => { if (!screenSubs[k]) screenSubs[k] = onValue(ref(db, `screens/${k}`), (x) => { S.screens[k] = x.val(); updateTile(k); }); });
      renderGrid();
    } else {
      S.students.forEach((st) => updateTile(st.key));
    }
    updateCounts();
  }));
  S.viewSubs.push(() => Object.values(screenSubs).forEach((u) => u()));
  audit('view_all', 'All online students');
  startViewer();
}

function renderMonitor(title, sub) {
  $('main').innerHTML = `
    <div class="toolbar">
      <h2>${esc(title)}</h2><span class="pill" id="counts"></span>
      <div class="spacer"></div>
      <button class="btn" id="b-focus">Focus mode…</button>
      <button class="btn" id="b-unfocus">End focus</button>
      <button class="btn" id="b-open">Open site…</button>
      <button class="btn" id="b-msg">Message…</button>
      <button class="btn danger" id="b-lock">Lock screens</button>
      <button class="btn" id="b-unlock">Unlock</button>
    </div>
    <div class="hint" style="margin:-6px 0 12px">${esc(sub)}</div>
    <div class="grid" id="grid"></div>`;
  const targets = () => S.students.map((s) => s.key);
  $('b-focus').onclick = () => focusModal(targets(), title);
  $('b-unfocus').onclick = () => setForAll(targets(), 'focus', null, 'end_focus', title);
  $('b-open').onclick = () => openUrlModal(targets(), title);
  $('b-msg').onclick = () => messageModal(targets(), title);
  $('b-lock').onclick = () => lockModal(targets(), title);
  $('b-unlock').onclick = () => setForAll(targets(), 'lock', null, 'unlock', title);
  renderGrid();
}

function renderGrid() {
  const g = $('grid');
  if (!g) return;
  if (!S.students.length) { g.innerHTML = '<div class="empty">No students here yet.</div>'; return; }
  g.innerHTML = S.students.map((st) => `<div class="tile" id="tile-${CSS.escape(st.key)}" data-k="${esc(st.key)}"></div>`).join('');
  g.querySelectorAll('.tile').forEach((el) => (el.onclick = () => openDrawer(el.dataset.k)));
  S.students.forEach((st) => updateTile(st.key));
  updateCounts();
}

function updateTile(k) {
  const el = document.getElementById('tile-' + k);
  if (!el) return;
  const st = S.students.find((x) => x.key === k) || { name: keyToEmail(k) };
  const p = S.presence[k];
  const sc = S.screens[k];
  const online = isOnline(p);
  const dot = online ? (p.idle === 'active' ? 'on' : 'idle') : '';
  const shot = sc && sc.img && online ? `<img src="${sc.img}" alt="">` : `<span>${online ? esc((sc && sc.note) || 'Waiting for screen…') : 'Offline'}</span>`;
  const act = (p && p.active) || {};
  el.className = 'tile' + (online ? '' : ' offline');
  el.innerHTML = `<div class="shot">${shot}</div>
    <div class="info"><div class="name"><span class="dot ${dot}"></span>${esc(st.name)}
      ${p && p.locked ? '<span class="pill red">Locked</span>' : ''}${p && p.focus ? '<span class="pill warn">Focus</span>' : ''}</div>
    <div class="url">${online ? esc(act.title || act.url || '') : p && p.lastSeen ? 'Last seen ' + esc(fmt(p.lastSeen)) : 'Never seen'}</div></div>`;
  if (S.selected === k) renderDrawer();
}

function updateCounts() {
  const c = $('counts');
  if (!c) return;
  const on = S.students.filter((s) => isOnline(S.presence[s.key])).length;
  c.textContent = `${on} online / ${S.students.length}`;
  c.className = 'pill' + (on ? ' on' : '');
}

// Tell students' extensions someone is watching (they only send screenshots while this is fresh).
function startViewer() {
  clearInterval(S.viewerTimer);
  const beat = () => {
    if (document.hidden) return;
    const upd = {};
    S.students.filter((s) => isOnline(S.presence[s.key])).slice(0, 60).forEach((s) => {
      upd[`inbox/${s.key}/viewer`] = { ts: serverTimestamp(), hi: S.selected === s.key, by: S.me.key };
    });
    if (S.selected && !upd[`inbox/${S.selected}/viewer`]) upd[`inbox/${S.selected}/viewer`] = { ts: serverTimestamp(), hi: true, by: S.me.key };
    if (Object.keys(upd).length) update(ref(db), upd).catch((e) => console.warn('viewer', e.message));
  };
  setTimeout(beat, 800);
  S.viewerTimer = setInterval(beat, 15000);
  S.viewerBeat = beat;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.viewerBeat) S.viewerBeat(); });

// ---------- actions ----------
function setForAll(keys, field, value, action, label, detail = {}) {
  if (!keys.length) return toast('No students to apply this to.');
  const upd = {};
  keys.forEach((k) => (upd[`inbox/${k}/${field}`] = value));
  return update(ref(db), upd).then(() => {
    toast(`Done for ${keys.length} student${keys.length === 1 ? '' : 's'}.`);
    audit(action, label, { count: keys.length, ...detail });
  }).catch((e) => toast('Failed: ' + e.message));
}

function sendCommand(keys, cmd, action, label) {
  if (!keys.length) return toast('No students to send to.');
  const upd = {};
  keys.forEach((k) => {
    const id = push(ref(db, `inbox/${k}/cmds`)).key;
    upd[`inbox/${k}/cmds/${id}`] = { ...cmd, by: S.me.key, ts: serverTimestamp() };
  });
  return update(ref(db), upd).then(() => {
    toast(`Sent to ${keys.length} student${keys.length === 1 ? '' : 's'}.`);
    audit(action, label, { count: keys.length, ...cmd });
  }).catch((e) => toast('Failed: ' + e.message));
}

function focusModal(keys, label) {
  const last = localStorage.getItem('am-focus') || 'classroom.google.com\ndocs.google.com\ndrive.google.com';
  modal(`<h3>Focus mode</h3>
    <p class="hint">Students can only open these sites until you end focus. Admin block policies still apply.</p>
    <label>Allowed sites <span class="hint">(one per line)</span></label><textarea id="f-list">${esc(last)}</textarea>
    <label>Label <span class="hint">(shown to students)</span></label><input id="f-label" value="${esc(label)} focus">
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="f-go">Start focus</button></div>`,
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
  modal(`<h3>Open a site</h3><label>Web address</label><input id="o-url" placeholder="https://">
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="o-go">Open</button></div>`,
  (m, close) => {
    m.querySelector('#o-go').onclick = () => {
      let url = m.querySelector('#o-url').value.trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      sendCommand(keys, { type: 'openUrl', url }, 'open_url', label);
      close();
    };
  });
}

function messageModal(keys, label) {
  modal(`<h3>Send a message</h3><textarea id="m-text" maxlength="500" placeholder="Message"></textarea>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="m-go">Send</button></div>`,
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
  modal(`<h3>Lock screens</h3><label>Message on the lock screen</label><input id="l-msg" value="Eyes up front, please.">
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn danger" id="l-go">Lock</button></div>`,
  (m, close) => {
    m.querySelector('#l-go').onclick = () => {
      setForAll(keys, 'lock', { on: true, message: m.querySelector('#l-msg').value, by: S.me.key, ts: serverTimestamp() }, 'lock', label);
      close();
    };
  });
}

// ---------- student drawer ----------
function openDrawer(k) {
  closeDrawer();
  S.selected = k;
  S.history = [];
  S.deviceSessions = [];
  $('drawer').classList.remove('hidden');
  S.drawerSubs.push(onValue(query(ref(db, `history/${k}`), limitToLast(150)), (s) => {
    S.history = Object.values(s.val() || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    renderDrawer();
  }));
  if (S.isAdmin) {
    S.drawerSubs.push(onValue(query(ref(db, 'deviceSessions'), orderByChild('student'), equalTo(k), limitToLast(15)), (s) => {
      S.deviceSessions = Object.values(s.val() || {}).sort((a, b) => (b.start || 0) - (a.start || 0));
      renderDrawer();
    }));
  }
  if (!S.screens[k] || S.view.type !== 'course') {
    S.drawerSubs.push(onValue(ref(db, `screens/${k}`), (s) => { S.screens[k] = s.val(); renderDrawer(); }));
  }
  audit('view_student', keyToEmail(k));
  renderDrawer();
  S.viewerBeat && S.viewerBeat();
}

function closeDrawer() {
  unsubAll(S.drawerSubs);
  const was = S.selected;
  S.selected = null;
  $('drawer').classList.add('hidden');
  if (was) update(ref(db), { [`inbox/${was}/viewer`]: { ts: serverTimestamp(), hi: false, by: S.me.key } }).catch(() => {});
}

function renderDrawer() {
  const k = S.selected;
  if (!k) return;
  const p = S.presence[k] || {};
  const sc = S.screens[k];
  const st = S.students.find((x) => x.key === k) || { name: p.name || keyToEmail(k), email: keyToEmail(k) };
  const online = isOnline(p);
  const d = p.device || {};
  const tabs = list(p.tabs);
  const one = [k];
  $('drawer').innerHTML = `
    <div class="toolbar"><h2>${esc(st.name)}</h2>
      <span class="pill ${online ? 'on' : ''}">${online ? (p.idle === 'active' ? 'Online' : 'Idle') : 'Offline'}</span>
      ${p.locked ? '<span class="pill red">Locked</span>' : ''}${p.focus ? '<span class="pill warn">Focus</span>' : ''}
      <div class="spacer"></div><button class="btn" id="d-close">Close</button></div>
    <div class="hint">${esc(st.email)} · Device serial <b>${esc(d.serial || 'unknown')}</b>${d.assetId ? ' · Asset ' + esc(d.assetId) : ''}${d.location ? ' · ' + esc(d.location) : ''}</div>
    <div class="toolbar" style="margin-top:12px">
      ${p.locked ? '<button class="btn" id="d-unlock">Unlock</button>' : '<button class="btn danger" id="d-lock">Lock</button>'}
      <button class="btn" id="d-msg">Message…</button><button class="btn" id="d-open">Open site…</button>
      ${p.focus ? '<button class="btn" id="d-unfocus">End focus</button>' : '<button class="btn" id="d-focus">Focus…</button>'}
    </div>
    <div class="big">${sc && sc.img ? `<img src="${sc.img}" alt="">` : esc(online ? (sc && sc.note) || 'Loading live screen…' : 'Offline')}</div>
    <div class="hint" style="margin-top:4px">${sc && sc.ts ? 'Updated ' + esc(fmtTime(sc.ts)) : ''}</div>
    <h3>Open tabs (${tabs.length})</h3>
    <div class="list">${tabs.length ? tabs.map((t) => `<div class="item">
        ${t.favIconUrl ? `<img src="${esc(t.favIconUrl)}" alt="">` : ''}
        <div class="grow"><div class="t">${t.active ? '<b>● </b>' : ''}${esc(t.title || t.url)}</div><div class="u">${esc(t.url)}</div></div>
        <button class="btn small" data-act="focusTab" data-tab="${t.id}">Show</button>
        <button class="btn small" data-act="closeTab" data-tab="${t.id}">Close</button></div>`).join('') : '<div class="item">No tabs reported.</div>'}</div>
    <h3>Recent browsing</h3>
    <div class="list">${S.history.length ? S.history.map((h) => `<div class="item ${h.blocked ? 'blockedrow' : ''}">
        <div class="hint" style="width:70px">${esc(fmtTime(h.ts))}</div>
        <div class="grow"><div class="t">${h.blocked ? '<b>Blocked</b> · ' + esc(h.policy || '') : esc(h.title || '')}</div><div class="u">${esc(h.url)}</div></div>
        <div class="hint">${esc(h.serial || '')}</div></div>`).join('') : '<div class="item">No history yet.</div>'}</div>
    ${S.isAdmin ? `<h3>Devices used</h3><div class="list">${S.deviceSessions.length ? S.deviceSessions.map((s) => `<div class="item">
        <div class="grow"><div class="t">Serial <b>${esc(s.serial || 'unknown')}</b>${s.assetId ? ' · Asset ' + esc(s.assetId) : ''}</div>
        <div class="u">${esc(fmt(s.start))} → ${esc(fmt(s.lastSeen))}${s.location ? ' · ' + esc(s.location) : ''}</div></div></div>`).join('') : '<div class="item">No device sessions.</div>'}</div>` : ''}`;
  $('d-close').onclick = closeDrawer;
  const lbl = st.email;
  $('d-lock') && ($('d-lock').onclick = () => lockModal(one, lbl));
  $('d-unlock') && ($('d-unlock').onclick = () => setForAll(one, 'lock', null, 'unlock', lbl));
  $('d-focus') && ($('d-focus').onclick = () => focusModal(one, lbl));
  $('d-unfocus') && ($('d-unfocus').onclick = () => setForAll(one, 'focus', null, 'end_focus', lbl));
  $('d-msg').onclick = () => messageModal(one, lbl);
  $('d-open').onclick = () => openUrlModal(one, lbl);
  $('drawer').querySelectorAll('[data-act]').forEach((b) => (b.onclick = () =>
    sendCommand(one, { type: b.dataset.act, tabId: Number(b.dataset.tab) }, b.dataset.act, lbl)));
}

// ---------- admin: settings ----------
function renderSettings() {
  const c = S.config;
  const cl = { ...(c.client || {}) };
  const sch = cl.schedule || { enabled: false, days: [1, 2, 3, 4, 5], start: '07:30', end: '15:30' };
  const days = list(sch.days).map(Number);
  const num = (id, label, val, hint = '') => `<div><label>${label} <span class="hint">${hint}</span></label><input id="${id}" type="number" step="any" value="${esc(val)}"></div>`;
  const chk = (id, label, on) => `<label class="check"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}>${label}</label>`;
  const radio = (val, title, desc) => `<label class="radio"><input type="radio" name="mode" value="${val}" ${mode() === val ? 'checked' : ''}><span><b>${title}</b><span class="hint">${desc}</span></span></label>`;
  $('main').innerHTML = `
    <div class="toolbar"><h2>Settings</h2><div class="spacer"></div><button class="btn primary" id="s-save">Save settings</button></div>
    <div class="panel"><h3>Who can view students</h3>
      ${radio('own_classes', 'Teachers see their own classes', 'Google Classroom rosters decide which students each teacher sees. Admins see everyone.')}
      ${radio('any_student', 'Staff can see any student', 'Any Classroom teacher or extra staff member can open any student. Admins see everyone.')}
      ${radio('admins_only', 'Admins only', 'Only the admins listed below can use the dashboard.')}
    </div>
    <div class="panel"><h3>People</h3>
      <div class="row"><div><label>Admins <span class="hint">(one email per line; full access incl. filtering)</span></label><textarea id="s-admins">${esc(mapToEmails(c.admins))}</textarea></div>
      <div><label>Extra staff <span class="hint">(non-Classroom staff who should have teacher access)</span></label><textarea id="s-staff">${esc(mapToEmails(c.extraStaff))}</textarea></div></div>
      <p class="hint">Roster last synced: ${c.lastRosterSync ? esc(fmt(c.lastRosterSync)) + ` (${c.lastRosterSyncCourses || 0} classes)` : 'never — run syncRosters in the Apps Script project'}</p>
    </div>
    <div class="panel"><h3>Monitoring schedule</h3>
      <p class="hint">Outside these hours, screens, tabs and history are not collected and teacher controls do nothing (uses each device's clock).</p>
      ${chk('s-sch', 'Only monitor during these hours', sch.enabled)}<br>
      ${DAYS.map((d, i) => chk('s-day' + i, d, days.includes(i))).join('')}
      <div class="row"><div><label>Start</label><input id="s-start" type="time" value="${esc(sch.start)}"></div><div><label>End</label><input id="s-end" type="time" value="${esc(sch.end)}"></div></div>
    </div>
    <div class="panel"><h3>Screens & data</h3>
      <div class="row">${num('s-shot', 'Thumbnail every', cl.screenshotSec ?? 15, 'seconds')}${num('s-live', 'Enlarged view every', cl.liveScreenshotSec ?? 3, 'seconds')}${num('s-q', 'JPEG quality', cl.jpegQuality ?? 0.45, '0.1–0.9')}</div>
      <div class="row">${num('s-tw', 'Thumbnail width', cl.thumbWidth ?? 320, 'px')}${num('s-lw', 'Enlarged width', cl.liveWidth ?? 1280, 'px')}${num('s-ret', 'Keep history for', cl.historyRetentionDays ?? 30, 'days')}</div>
      <div class="row">${num('s-hb', 'Status update every', cl.heartbeatSec ?? 15, 'seconds')}${num('s-poll', 'Check for commands every', cl.inboxPollSec ?? 15, 'sec (0 = live; needs paid plan)')}<div></div></div>
      ${chk('s-ind', 'Show students a LIVE badge while being viewed', cl.showViewingIndicator !== false)}
      ${chk('s-hist', 'Record browsing history', cl.logHistory !== false)}
      ${chk('s-fa', 'Apply web filtering outside the monitoring schedule', cl.filterAlways !== false)}
      <label>Always-reachable sites <span class="hint">(sign-in pages etc. — never blocked, even in focus mode)</span></label>
      <textarea id="s-ess">${esc(list(cl.essentialDomains).join('\n'))}</textarea>
    </div>`;
  $('s-save').onclick = async () => {
    const admins = emailsToMap($('s-admins').value);
    if (!admins[S.me.key] && !confirm('You are removing yourself as an admin. Continue?')) return;
    const n = (id, d) => { const v = Number($(id).value); return Number.isFinite(v) && v > 0 ? v : d; };
    const client = {
      ...cl,
      schedule: { enabled: $('s-sch').checked, days: DAYS.map((_, i) => i).filter((i) => $('s-day' + i).checked), start: $('s-start').value, end: $('s-end').value },
      screenshotSec: n('s-shot', 15), liveScreenshotSec: n('s-live', 3), jpegQuality: Math.min(0.9, n('s-q', 0.45)),
      thumbWidth: n('s-tw', 320), liveWidth: n('s-lw', 1280), historyRetentionDays: n('s-ret', 30),
      heartbeatSec: n('s-hb', 15), inboxPollSec: Math.max(0, Number($('s-poll').value) || 0),
      showViewingIndicator: $('s-ind').checked, logHistory: $('s-hist').checked, filterAlways: $('s-fa').checked,
      essentialDomains: domains(lines($('s-ess').value)),
    };
    const accessMode = (document.querySelector('input[name=mode]:checked') || {}).value || 'own_classes';
    try {
      await update(ref(db, 'config'), { accessMode, admins, extraStaff: emailsToMap($('s-staff').value), client });
      await bumpRev();
      audit('settings', 'config', { accessMode });
      toast('Settings saved.');
    } catch (e) { toast('Save failed: ' + e.message); }
  };
}

// ---------- admin: web filtering ----------
const ACTION_LABEL = { block: 'Block', allow: 'Always allow (whitelist)', allowOnly: 'Only allow' };

function targetText(p) {
  const t = p.targets || { all: true };
  if (t.all) return 'All students';
  const parts = [];
  const cs = Object.keys(t.courses || {});
  if (cs.length) parts.push(cs.map((id) => (S.courses[id] && S.courses[id].name) || id).join(', '));
  const ss = Object.keys(t.students || {});
  if (ss.length) parts.push(`${ss.length} student${ss.length === 1 ? '' : 's'}`);
  return parts.join(' + ') || 'Nobody';
}

function renderFiltering() {
  $('main').innerHTML = `
    <div class="toolbar"><h2>Web filtering</h2><div class="spacer"></div><button class="btn primary" id="p-new">New policy</button></div>
    <div class="panel"><h3>Policies</h3>
      <p class="hint">How rules combine: always-reachable sites → teacher focus mode → <b>Always allow</b> → <b>Block</b> → <b>Only allow</b>. An always-allow (whitelist) entry beats any block.</p>
      <div id="p-table"><div class="empty">Loading…</div></div></div>
    <div class="panel"><h3>Test a web address</h3>
      <div class="row"><div><label>Web address</label><input id="t-url" placeholder="https://example.com"></div>
      <div><label>Student email <span class="hint">(optional — uses their classes)</span></label><input id="t-who" placeholder="student@${esc(CONFIG.DOMAIN)}"></div></div>
      <div class="actions" style="justify-content:flex-start"><button class="btn" id="t-go">Test</button><span id="t-out"></span></div></div>
    <div class="panel"><h3>Recent blocked attempts</h3><div id="b-table"><div class="empty">Loading…</div></div></div>`;
  $('p-new').onclick = () => policyModal(null, {});
  S.viewSubs.push(onValue(ref(db, 'policies'), (s) => {
    S.policies = s.val() || {};
    const rows = Object.entries(S.policies).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
    $('p-table').innerHTML = rows.length ? `<table><tr><th>On</th><th>Name</th><th>Type</th><th>Applies to</th><th>Sites / keywords</th><th>Schedule</th><th></th></tr>
      ${rows.map(([id, p]) => `<tr>
        <td><input type="checkbox" data-toggle="${esc(id)}" ${p.enabled !== false ? 'checked' : ''} style="width:auto"></td>
        <td><b>${esc(p.name)}</b></td><td>${esc(ACTION_LABEL[p.action] || p.action)}</td><td>${esc(targetText(p))}</td>
        <td>${list(p.domains).length} sites${list(p.keywords).length ? `, ${list(p.keywords).length} keywords` : ''}</td>
        <td>${p.schedule && p.schedule.enabled ? esc(list(p.schedule.days).map((d) => DAYS[d]).join(' ') + ' ' + p.schedule.start + '–' + p.schedule.end) : 'Always'}</td>
        <td><button class="btn small" data-edit="${esc(id)}">Edit</button> <button class="btn small" data-del="${esc(id)}">Delete</button></td></tr>`).join('')}</table>`
      : '<div class="empty">No policies yet. Create one to start blocking or whitelisting sites.</div>';
    $('p-table').querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => policyModal(b.dataset.edit, S.policies[b.dataset.edit])));
    $('p-table').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
      const p = S.policies[b.dataset.del];
      if (!confirm(`Delete policy "${p.name}"?`)) return;
      await set(ref(db, `policies/${b.dataset.del}`), null);
      await bumpRev();
      audit('policy_delete', p.name);
    }));
    $('p-table').querySelectorAll('[data-toggle]').forEach((b) => (b.onchange = async () => {
      await update(ref(db, `policies/${b.dataset.toggle}`), { enabled: b.checked, updatedAt: serverTimestamp(), updatedBy: S.me.email });
      await bumpRev();
      audit(b.checked ? 'policy_enable' : 'policy_disable', S.policies[b.dataset.toggle].name);
    }));
  }));
  S.viewSubs.push(onValue(query(ref(db, 'blockLog'), limitToLast(200)), (s) => {
    const rows = Object.values(s.val() || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    $('b-table').innerHTML = rows.length ? `<table><tr><th>When</th><th>Student</th><th>Address</th><th>Why</th><th>Device</th></tr>
      ${rows.map((r) => `<tr><td>${esc(fmt(r.ts))}</td><td>${esc(r.email)}</td><td style="word-break:break-all">${esc(r.url)}</td><td>${esc(r.policy || r.reason)}</td><td>${esc(r.serial || '')}</td></tr>`).join('')}</table>`
      : '<div class="empty">Nothing blocked yet.</div>';
  }));
  $('t-go').onclick = async () => {
    let url = $('t-url').value.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const who = $('t-who').value.trim().toLowerCase();
    const k = who ? emailKey(who) : '__nobody__';
    const courses = who ? (await get(ref(db, `studentCourses/${k}`)).catch(() => null))?.val() || {} : {};
    const active = activePolicies(S.policies, k, courses);
    const r = evaluate(url, { active, focus: null, essentials: list((S.config.client || {}).essentialDomains) });
    $('t-out').innerHTML = r.blocked
      ? `<span class="pill red">Blocked</span> ${esc(r.policy || '')} — ${esc(REASON_TEXT[r.reason] || r.reason)}`
      : `<span class="pill on">Allowed</span> ${r.policy ? 'by ' + esc(r.policy) : ''} <span class="hint">(${active.length} policies apply right now)</span>`;
  };
}

function policyModal(id, p) {
  const t = p.targets || { all: true };
  const sch = p.schedule || { enabled: false, days: [1, 2, 3, 4, 5], start: '08:00', end: '15:00' };
  const days = list(sch.days).map(Number);
  const courses = Object.entries(S.courses).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  modal(`<h3>${id ? 'Edit' : 'New'} filter policy</h3>
    <label>Name</label><input id="e-name" value="${esc(p.name || '')}" placeholder="e.g. Block games">
    <label>Type</label><select id="e-action">
      ${Object.entries(ACTION_LABEL).map(([v, l]) => `<option value="${v}" ${(p.action || 'block') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <p class="hint" id="e-help"></p>
    <label>Sites <span class="hint">(one per line — a domain covers all its subdomains, e.g. roblox.com)</span></label>
    <textarea id="e-domains">${esc(list(p.domains).join('\n'))}</textarea>
    <div id="e-kw-wrap"><label>Blocked keywords <span class="hint">(blocks any address containing the word)</span></label>
    <textarea id="e-kw" style="min-height:60px">${esc(list(p.keywords).join('\n'))}</textarea></div>
    <label>Applies to</label>
    <label class="check"><input type="radio" name="e-tgt" value="all" ${t.all ? 'checked' : ''}>All students</label>
    <label class="check"><input type="radio" name="e-tgt" value="some" ${t.all ? '' : 'checked'}>Specific classes / students</label>
    <div id="e-some">
      <label>Classes</label><div class="courselist">${courses.length ? courses.map(([cid, c]) => `<label class="check" style="display:flex"><input type="checkbox" data-course="${esc(cid)}" ${t.courses && t.courses[cid] ? 'checked' : ''}>${esc(c.name)} <span class="hint">${esc(c.section || '')}</span></label>`).join('') : '<span class="hint">No classes synced yet.</span>'}</div>
      <label>Students <span class="hint">(emails, one per line)</span></label><textarea id="e-students" style="min-height:60px">${esc(mapToEmails(t.students))}</textarea>
    </div>
    <label>Except these students <span class="hint">(emails)</span></label><textarea id="e-except" style="min-height:50px">${esc(mapToEmails(p.except))}</textarea>
    <label>Schedule</label>
    <label class="check"><input type="checkbox" id="e-sch" ${sch.enabled ? 'checked' : ''}>Only active during these times</label><br>
    ${DAYS.map((d, i) => `<label class="check"><input type="checkbox" id="e-day${i}" ${days.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}
    <div class="row"><div><label>Start</label><input type="time" id="e-start" value="${esc(sch.start)}"></div><div><label>End</label><input type="time" id="e-end" value="${esc(sch.end)}"></div></div>
    <label class="check" style="margin-top:12px"><input type="checkbox" id="e-enabled" ${p.enabled !== false ? 'checked' : ''}>Policy enabled</label>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="e-save">Save policy</button></div>`,
  (m, close) => {
    const help = {
      block: 'Students cannot visit these sites (or any address containing a keyword).',
      allow: 'Whitelist: these sites are always allowed, even if another policy blocks them.',
      allowOnly: 'Students can ONLY visit these sites (plus always-allow and always-reachable sites).',
    };
    const sync = () => {
      const a = m.querySelector('#e-action').value;
      m.querySelector('#e-help').textContent = help[a];
      m.querySelector('#e-kw-wrap').style.display = a === 'block' ? '' : 'none';
      m.querySelector('#e-some').style.display = m.querySelector('input[name=e-tgt]:checked').value === 'some' ? '' : 'none';
    };
    m.querySelectorAll('select,input[name=e-tgt]').forEach((el) => (el.onchange = sync));
    sync();
    m.querySelector('#e-save').onclick = async () => {
      const name = m.querySelector('#e-name').value.trim();
      const action = m.querySelector('#e-action').value;
      const doms = domains(lines(m.querySelector('#e-domains').value));
      const kws = action === 'block' ? keywords(lines(m.querySelector('#e-kw').value)) : [];
      if (!name) return toast('Give the policy a name.');
      if (action !== 'allowOnly' && !doms.length && !kws.length) return toast('Add at least one site or keyword.');
      const all = m.querySelector('input[name=e-tgt]:checked').value === 'all';
      const targets = all ? { all: true } : {
        all: false,
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
        toast('Policy saved. Students pick it up within ~5 minutes.');
        close();
      } catch (e) { toast('Save failed: ' + e.message); }
    };
  });
}

// ---------- admin: devices ----------
function renderDevices() {
  $('main').innerHTML = `
    <div class="toolbar"><h2>Devices</h2><div class="spacer"></div><button class="btn" id="dv-csv">Export CSV</button></div>
    <div class="panel"><div class="row"><div><label>Search by device serial or student email</label><input id="dv-q" placeholder="Serial number or student@${esc(CONFIG.DOMAIN)}"></div></div>
      <div class="actions" style="justify-content:flex-start"><button class="btn primary" id="dv-go">Search</button><button class="btn" id="dv-recent">Show recent</button></div></div>
    <div id="dv-table"><div class="empty">Loading…</div></div>`;
  let rows = [];
  let unsub = null;
  const show = (q) => {
    unsub && unsub();
    $('dv-table').innerHTML = '<div class="empty">Loading…</div>';
    unsub = onValue(q, (s) => {
      rows = Object.values(s.val() || {}).sort((a, b) => (b.start || 0) - (a.start || 0));
      $('dv-table').innerHTML = rows.length ? `<table><tr><th>Signed in</th><th>Last seen</th><th>Student</th><th>Serial</th><th>Asset ID</th><th>Location</th></tr>
        ${rows.map((r) => `<tr><td>${esc(fmt(r.start))}</td><td>${esc(fmt(r.lastSeen))}</td><td>${esc(r.name || '')}<div class="hint">${esc(r.email)}</div></td>
        <td><b>${esc(r.serial || 'unknown')}</b></td><td>${esc(r.assetId || '')}</td><td>${esc(r.location || '')}</td></tr>`).join('')}</table>`
        : '<div class="empty">No sessions found.</div>';
    }, (e) => ($('dv-table').innerHTML = `<div class="empty">${esc(e.message)}</div>`));
  };
  S.viewSubs.push(() => unsub && unsub());
  const recent = () => show(query(ref(db, 'deviceSessions'), limitToLast(150)));
  $('dv-recent').onclick = recent;
  $('dv-go').onclick = () => {
    const q = $('dv-q').value.trim();
    if (!q) return recent();
    if (q.includes('@')) show(query(ref(db, 'deviceSessions'), orderByChild('student'), equalTo(emailKey(q)), limitToLast(200)));
    else show(query(ref(db, 'deviceSessions'), orderByChild('serial'), equalTo(q.toUpperCase()), limitToLast(200)));
  };
  $('dv-q').onkeydown = (e) => { if (e.key === 'Enter') $('dv-go').click(); };
  $('dv-csv').onclick = () => {
    const head = ['start', 'lastSeen', 'name', 'email', 'serial', 'assetId', 'location', 'directoryId'];
    const csv = [head.join(',')].concat(rows.map((r) => head.map((h) => {
      const v = h === 'start' || h === 'lastSeen' ? new Date(r[h] || 0).toISOString() : r[h] || '';
      return '"' + String(v).replace(/"/g, '""') + '"';
    }).join(','))).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'adena-monitor-devices.csv';
    a.click();
  };
  recent();
}

// ---------- admin: activity log ----------
function renderAudit() {
  $('main').innerHTML = `<div class="toolbar"><h2>Activity log</h2><span class="hint">Every view, lock, message, focus and policy change by staff.</span></div><div id="a-table"><div class="empty">Loading…</div></div>`;
  S.viewSubs.push(onValue(query(ref(db, 'audit'), limitToLast(300)), (s) => {
    const rows = Object.values(s.val() || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    $('a-table').innerHTML = rows.length ? `<table><tr><th>When</th><th>Staff</th><th>Action</th><th>Target</th><th>Details</th></tr>
      ${rows.map((r) => `<tr><td>${esc(fmt(r.ts))}</td><td>${esc(r.email)}</td><td>${esc(r.action)}</td><td>${esc(r.target)}</td>
      <td class="hint" style="word-break:break-all">${esc(JSON.stringify(r.detail || {}))}</td></tr>`).join('')}</table>`
      : '<div class="empty">No activity yet.</div>';
  }));
}
