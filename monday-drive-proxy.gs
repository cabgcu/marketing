/**
 * Monday.com → Google Drive Proxy
 *
 * Accepts either:
 *   { sourceUrl: "https://...", filename: "file.jpg" }   ← URL fetch (used by attachment sync)
 *   { base64: "...", mimeType: "image/jpeg", filename: "file.jpg" }  ← base64 upload (legacy)
 *
 * doGet(?id=<driveFileId>) reads a file straight off Drive via DriveApp
 * (authenticated as the deploying account) and returns it as base64 JSON.
 * This is what the app's video/large-file download button calls — it exists
 * because drive.google.com's public export=download URLs serve a small HTML
 * "can't scan this file for viruses" page instead of the real bytes for
 * videos and other unscannable types when fetched anonymously.
 *
 * Deploy as a Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 * Then paste the /exec URL into Settings → Monday.com → "Drive Proxy URL".
 */

const PROXY_FOLDER_NAME = 'CAB Deliverables';

function doGet(e) {
  try {
    const id = e && e.parameter && e.parameter.id;
    if (!id) return jsonOut({ success: false, error: 'Missing id parameter' });

    const file = DriveApp.getFileById(id);
    const blob = file.getBlob();
    return jsonOut({
      success: true,
      name: file.getName(),
      mimeType: blob.getContentType() || 'application/octet-stream',
      base64: Utilities.base64Encode(blob.getBytes())
    });
  } catch (err) {
    return jsonOut({ success: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    let blob;

    if (payload.sourceUrl) {
      const resp = UrlFetchApp.fetch(payload.sourceUrl, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) {
        return jsonOut({ success: false, error: 'Source fetch failed: HTTP ' + resp.getResponseCode() });
      }
      blob = resp.getBlob().setName(payload.filename || 'file');
    } else if (payload.base64) {
      const bytes = Utilities.base64Decode(payload.base64);
      blob = Utilities.newBlob(bytes, payload.mimeType || 'application/octet-stream', payload.filename || 'file');
    } else {
      return jsonOut({ success: false, error: 'Provide sourceUrl or base64' });
    }

    return uploadBlob(blob);
  } catch (err) {
    return jsonOut({ success: false, error: String(err) });
  }
}

function uploadBlob(blob) {
  const folder = getOrCreateFolder(PROXY_FOLDER_NAME);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
  return jsonOut({ success: true, url: url, name: file.getName() });
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
