/**
 * Adena Ink Web - Apps Script backend.
 * Runs as the person using it, so notebooks live in THEIR Drive, in the same
 * "Adena Ink" folder and .adenaink format the Chrome extension uses.
 */
var FOLDER_NAME = 'Adena Ink';
var FOLDER_MIME = 'application/vnd.google-apps.folder';
var SUBJECTS = ['Maths', 'Science', 'Languages', 'Organizers', 'Art', 'Music', 'General'];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('App')
    .setTitle('Adena Ink')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function folder_() {
  var it = DriveApp.getRootFolder().getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.getRootFolder().createFolder(FOLDER_NAME);
}

function safeName_(n) {
  return String(n || 'Notebook').replace(/[\\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Notebook';
}

/** Who is signed in, for the greeting. */
function boot() {
  var email = Session.getActiveUser().getEmail() || '';
  var first = email.split('@')[0].split(/[._-]/)[0] || '';
  first = first.replace(/[0-9]+/g, '');
  return { email: email, first: first ? first.charAt(0).toUpperCase() + first.slice(1) : '' };
}

/** Every .adenaink notebook the person owns (made here or in the extension), plus ones shared with them. */
function listNotebooks() {
  var out = [], seen = {};
  var add = function (f, shared) {
    var name = f.getName(), id = f.getId();
    if (!/\.adenaink$/i.test(name) || seen[id]) return;
    seen[id] = true;
    var subject = '', by = '';
    try { var ps = f.getParents(); if (ps.hasNext()) { var p = ps.next().getName(); if (SUBJECTS.indexOf(p) >= 0) subject = p; } } catch (e) {}
    if (shared) { try { var o = f.getOwner(); by = o ? (o.getName() || o.getEmail()) : ''; } catch (e) {} }
    out.push({ id: id, name: name.replace(/\.adenaink$/i, ''), modified: f.getLastUpdated().getTime(), size: f.getSize(), subject: subject, shared: shared, by: by });
  };
  var it = DriveApp.searchFiles("title contains '.adenaink' and trashed = false and 'me' in owners");
  while (it.hasNext() && out.length < 300) add(it.next(), false);
  var n = 0, sh = DriveApp.searchFiles("title contains '.adenaink' and trashed = false and sharedWithMe");
  while (sh.hasNext() && n++ < 100) add(sh.next(), true);
  out.sort(function (a, b) { return b.modified - a.modified; });
  return out;
}

function getNotebook(id) {
  var f = DriveApp.getFileById(id);
  return { id: id, name: f.getName().replace(/\.adenaink$/i, ''), text: f.getBlob().getDataAsString() };
}

/**
 * Create (id empty) or update a notebook. Returns its id.
 * To keep saves small, boards whose PDF/camera picture is already in the file can be sent as
 * {snapRef: n} (board n of the saved file) along with baseRev, the "rev" of that saved file.
 * If the file changed in between (for example the extension saved it), this asks for a full save.
 */
function saveNotebook(id, name, text, baseRev) {
  var fileName = safeName_(name) + '.adenaink';
  if (id && baseRev) {
    var nb = JSON.parse(text), old;
    try { old = JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString()); } catch (e) { throw new Error('NEEDFULL'); }
    if (!old || old.rev !== baseRev || !old.boards) throw new Error('NEEDFULL');
    nb.boards.forEach(function (b) {
      if (b.snapRef === undefined) return;
      var src = old.boards[b.snapRef];
      if (!src || !src.snap) throw new Error('NEEDFULL');
      b.snap = src.snap; delete b.snapRef;
    });
    text = JSON.stringify(nb);
  }
  if (id) {
    try {
      var f = DriveApp.getFileById(id);
      if (!f.isTrashed()) {
        if (f.getName() !== fileName) { try { f.setName(fileName); } catch (e) {} }
        try {
          f.setContent(text);
          return { id: f.getId(), saved: Date.now() };
        } catch (big) {
          // Very large notebooks are written as a new file, then the old one is trashed.
          // A notebook someone shared with view-only access lands here too: it becomes the person's own copy.
          var bf = folder_().createFile(Utilities.newBlob(text, 'application/json', fileName));
          var copied = false;
          try { f.setTrashed(true); } catch (e) { copied = true; }
          return { id: bf.getId(), saved: Date.now(), copied: copied };
        }
      }
    } catch (e) { /* deleted in Drive: make a new one below */ }
  }
  var nf = folder_().createFile(Utilities.newBlob(text, 'application/json', fileName));
  return { id: nf.getId(), saved: Date.now() };
}

/** "Save as PDF to Drive": a PDF of the boards (with ink) in the Adena Ink folder. */
function savePdfCopy(name, b64) {
  var fileName = safeName_(name) + '.pdf';
  var f = folder_().createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'application/pdf', fileName));
  return { id: f.getId(), name: fileName, url: f.getUrl() };
}

/** PDFs the person can open (their own or shared with them), newest first. */
function listPdfs(q) {
  var query = "mimeType = 'application/pdf' and trashed = false";
  q = String(q || '').trim();
  if (q) query += " and title contains '" + q.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  var it = DriveApp.searchFiles(query), out = [];
  while (it.hasNext() && out.length < 200) {
    var f = it.next();
    out.push({ id: f.getId(), name: f.getName(), modified: f.getLastUpdated().getTime(), size: f.getSize() });
  }
  out.sort(function (a, b) { return b.modified - a.modified; });
  return out.slice(0, 80);
}

/** A PDF's bytes as base64 (the page draws each PDF page as a board). */
function getPdf(id) {
  var f = DriveApp.getFileById(id);
  if (f.getSize() > 40 * 1024 * 1024) throw new Error('That PDF is larger than 40 MB. Try a smaller one.');
  return { name: f.getName(), b64: Utilities.base64Encode(f.getBlob().getBytes()) };
}

function renameNotebook(id, name) {
  DriveApp.getFileById(id).setName(safeName_(name) + '.adenaink');
  return true;
}

function deleteNotebook(id) {
  DriveApp.getFileById(id).setTrashed(true);
  return true;
}
