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

/** Every .adenaink notebook the person owns (made here or in the extension). */
function listNotebooks() {
  var out = [];
  var it = DriveApp.searchFiles("title contains '.adenaink' and trashed = false and 'me' in owners");
  while (it.hasNext() && out.length < 300) {
    var f = it.next();
    var name = f.getName();
    if (!/\.adenaink$/i.test(name)) continue;
    var subject = '';
    var ps = f.getParents();
    if (ps.hasNext()) { var p = ps.next().getName(); if (SUBJECTS.indexOf(p) >= 0) subject = p; }
    out.push({ id: f.getId(), name: name.replace(/\.adenaink$/i, ''), modified: f.getLastUpdated().getTime(), size: f.getSize(), subject: subject });
  }
  out.sort(function (a, b) { return b.modified - a.modified; });
  return out;
}

function getNotebook(id) {
  var f = DriveApp.getFileById(id);
  return { id: id, name: f.getName().replace(/\.adenaink$/i, ''), text: f.getBlob().getDataAsString() };
}

/** Create (id empty) or update a notebook. Returns its id. */
function saveNotebook(id, name, text) {
  var fileName = safeName_(name) + '.adenaink';
  if (id) {
    try {
      var f = DriveApp.getFileById(id);
      if (!f.isTrashed()) {
        if (f.getName() !== fileName) f.setName(fileName);
        f.setContent(text);
        return { id: f.getId(), saved: Date.now() };
      }
    } catch (e) { /* deleted in Drive: make a new one below */ }
  }
  var nf = folder_().createFile(fileName, text, 'application/json');
  return { id: nf.getId(), saved: Date.now() };
}

function renameNotebook(id, name) {
  DriveApp.getFileById(id).setName(safeName_(name) + '.adenaink');
  return true;
}

function deleteNotebook(id) {
  DriveApp.getFileById(id).setTrashed(true);
  return true;
}
