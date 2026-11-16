// Adena Monitor — shared filtering logic.
// This exact file is used by the student extension (enforcement) and the
// staff dashboard (the "Test a URL" tool), so both always agree.
//
// Policy shape (stored at /policies/{id}):
// {
//   name: "Block games",
//   enabled: true,
//   action: "block" | "allow" | "allowOnly",
//      block     = block these domains / URL keywords
//      allow     = whitelist: always allow these domains (beats any block or allow-only policy)
//      allowOnly = students may ONLY visit these domains
//   domains:  ["coolmathgames.com", ...],
//   keywords: ["proxy", ...],               // block policies only, matched anywhere in the URL
//   targets:  { all: true, courses: {courseId: true}, students: {emailKey: true} },
//   except:   { emailKey: true },           // students this policy never applies to
//   schedule: { enabled: false, days: [1,2,3,4,5], start: "07:30", end: "15:30" }
// }

export function emailKey(email) {
  return String(email || '').trim().toLowerCase().replace(/\./g, ',');
}

export function keyToEmail(key) {
  return String(key || '').replace(/,/g, '.');
}

export function list(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined);
  if (typeof v === 'object') return Object.values(v);
  return [v];
}

export function normDomain(s) {
  let d = String(s || '').trim().toLowerCase();
  if (!d || d.startsWith('#')) return '';
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  d = d.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  d = d.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(d) ? d : '';
}

export function domains(v) {
  return [...new Set(list(v).map(normDomain).filter(Boolean))];
}

export function keywords(v) {
  return [...new Set(list(v).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean))];
}

export function hostMatches(host, domainList) {
  host = String(host || '').toLowerCase();
  return domainList.some((d) => host === d || host.endsWith('.' + d));
}

function minutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function inSchedule(schedule, date = new Date()) {
  if (!schedule || !schedule.enabled) return true;
  const days = list(schedule.days).map(Number);
  if (days.length && !days.includes(date.getDay())) return false;
  const start = minutes(schedule.start);
  const end = minutes(schedule.end);
  if (start === null || end === null) return true;
  const now = date.getHours() * 60 + date.getMinutes();
  return start <= end ? now >= start && now < end : now >= start || now < end;
}

export function policyApplies(policy, studentKeyValue, courses) {
  if (!policy || policy.enabled === false) return false;
  if (policy.except && policy.except[studentKeyValue]) return false;
  const t = policy.targets || { all: true };
  if (t.all) return true;
  if (t.students && t.students[studentKeyValue]) return true;
  return Object.keys(t.courses || {}).some((c) => courses && courses[c]);
}

// Returns the list of policies in force for one student right now.
export function activePolicies(policies, studentKeyValue, courses, date = new Date()) {
  return Object.entries(policies || {})
    .map(([id, p]) => ({ id, ...p }))
    .filter((p) => policyApplies(p, studentKeyValue, courses) && inSchedule(p.schedule, date))
    .map((p) => ({
      id: p.id,
      name: p.name || 'Untitled policy',
      action: p.action || 'block',
      domains: domains(p.domains),
      keywords: p.action === 'block' || !p.action ? keywords(p.keywords) : [],
    }));
}

// ctx = { active: [...activePolicies], focus: {on, allowed:[...] } | null, essentials: [...] }
export function evaluate(url, ctx) {
  let u;
  try { u = new URL(url); } catch { return { blocked: false }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { blocked: false };
  const host = u.hostname.toLowerCase();
  const full = url.toLowerCase();
  const essentials = domains(ctx.essentials);
  if (hostMatches(host, essentials)) return { blocked: false, reason: 'essential' };

  if (ctx.focus && ctx.focus.on) {
    const allowed = domains(ctx.focus.allowed);
    if (!hostMatches(host, allowed)) {
      return { blocked: true, reason: 'focus', policy: ctx.focus.label || 'Teacher focus mode' };
    }
  }
  for (const p of ctx.active.filter((p) => p.action === 'allow')) {
    if (hostMatches(host, p.domains)) return { blocked: false, reason: 'allow', policy: p.name };
  }
  for (const p of ctx.active.filter((p) => p.action === 'block')) {
    if (hostMatches(host, p.domains)) return { blocked: true, reason: 'block', policy: p.name };
    const kw = p.keywords.find((k) => full.includes(k));
    if (kw) return { blocked: true, reason: 'keyword', policy: p.name, keyword: kw };
  }
  for (const p of ctx.active.filter((p) => p.action === 'allowOnly')) {
    if (!hostMatches(host, p.domains)) return { blocked: true, reason: 'allowOnly', policy: p.name };
  }
  return { blocked: false };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Builds chrome.declarativeNetRequest rules that mirror evaluate().
// Higher priority wins: essentials 400 > focus 300 > allow 200 > block 100 > allowOnly 90.
export function buildDnrRules(ctx, blockedPageUrl) {
  const rules = [];
  let id = 1;
  const redirect = { type: 'redirect', redirect: { regexSubstitution: blockedPageUrl + '#\\0' } };
  const ALL = '^https?://.*';
  const essentials = domains(ctx.essentials);

  if (essentials.length) {
    rules.push({ id: id++, priority: 400, action: { type: 'allow' },
      condition: { requestDomains: essentials, resourceTypes: ['main_frame'] } });
  }
  if (ctx.focus && ctx.focus.on) {
    const allowed = domains(ctx.focus.allowed);
    const condition = { regexFilter: ALL, resourceTypes: ['main_frame'] };
    if (allowed.length) condition.excludedRequestDomains = allowed;
    rules.push({ id: id++, priority: 300, action: redirect, condition });
  }
  const allowDomains = [...new Set(ctx.active.filter((p) => p.action === 'allow').flatMap((p) => p.domains))];
  if (allowDomains.length) {
    rules.push({ id: id++, priority: 200, action: { type: 'allow' },
      condition: { requestDomains: allowDomains, resourceTypes: ['main_frame', 'sub_frame'] } });
  }
  const blockPolicies = ctx.active.filter((p) => p.action === 'block');
  const blockDomains = [...new Set(blockPolicies.flatMap((p) => p.domains))];
  if (blockDomains.length) {
    rules.push({ id: id++, priority: 100, action: redirect,
      condition: { regexFilter: ALL, requestDomains: blockDomains, resourceTypes: ['main_frame'] } });
    rules.push({ id: id++, priority: 100, action: { type: 'block' },
      condition: { requestDomains: blockDomains, resourceTypes: ['sub_frame'] } });
  }
  const kws = [...new Set(blockPolicies.flatMap((p) => p.keywords))];
  for (const k of kws) {
    rules.push({ id: id++, priority: 100, action: redirect,
      condition: { regexFilter: '^https?://.*' + escapeRe(k) + '.*', isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame'] } });
  }
  for (const p of ctx.active.filter((p) => p.action === 'allowOnly')) {
    const condition = { regexFilter: ALL, resourceTypes: ['main_frame'] };
    if (p.domains.length) condition.excludedRequestDomains = p.domains;
    rules.push({ id: id++, priority: 90, action: redirect, condition });
  }
  return rules;
}

export const REASON_TEXT = {
  focus: 'Your teacher has limited your browsing to class sites right now.',
  block: 'This site is blocked by your school.',
  keyword: 'This page is blocked by your school.',
  allowOnly: 'Only approved sites are allowed right now.',
};
