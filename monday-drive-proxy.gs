/**
 * Monday.com → Google Drive Proxy
 *
 * Accepts either:
 *   { sourceUrl: "https://...", filename: "file.jpg" }   ← URL fetch (used by attachment sync)
 *   { base64: "...", mimeType: "image/jpeg", filename: "file.jpg" }  ← base64 upload (legacy)
 *   { uploadId, chunkIndex, totalChunks, filename, mimeType, chunk: "..." }
 *       ← chunked base64 upload, used for large files (e.g. video) that would
 *         otherwise exceed the web app's request-size/timeout limits in one POST
 *
 * Deploy as a Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 * Then paste the /exec URL into Settings → Monday.com → "Drive Proxy URL".
 */

const PROXY_FOLDER_NAME = 'CAB Deliverables';
const CHUNK_TEMP_FOLDER_NAME = 'CAB Deliverables Temp Uploads';

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    if (payload.chunk !== undefined) {
      return handleChunkedUpload(payload);
    }

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

// Handles one chunk of a large (e.g. video) upload. Each chunk is stashed as
// its own temp file in Drive (Apps Script has no scratch space big enough to
// hold multi-megabyte chunks between requests). On the final chunk, the temp
// files are stitched back together into the real upload and cleaned up.
function handleChunkedUpload(payload) {
  const uploadId = payload.uploadId;
  const chunkIndex = payload.chunkIndex;
  const totalChunks = payload.totalChunks;
  if (!uploadId || chunkIndex === undefined || chunkIndex === null || !totalChunks) {
    return jsonOut({ success: false, error: 'Missing chunk metadata' });
  }

  const tempRoot = getOrCreateFolder(CHUNK_TEMP_FOLDER_NAME);
  const chunkFolder = getOrCreateSubfolder(tempRoot, 'upload_' + uploadId);
  const chunkBytes = Utilities.base64Decode(payload.chunk);
  const chunkName = 'chunk_' + Utilities.formatString('%06d', chunkIndex);
  chunkFolder.createFile(Utilities.newBlob(chunkBytes, 'application/octet-stream', chunkName));

  if (chunkIndex < totalChunks - 1) {
    return jsonOut({ success: true, chunkReceived: chunkIndex });
  }

  // Final chunk: reassemble all chunks in order, upload, then clean up temp files.
  try {
    const files = chunkFolder.getFiles();
    const chunkFiles = [];
    while (files.hasNext()) chunkFiles.push(files.next());
    chunkFiles.sort((a, b) => a.getName().localeCompare(b.getName()));

    if (chunkFiles.length !== totalChunks) {
      return jsonOut({ success: false, error: 'Upload incomplete: received ' + chunkFiles.length + ' of ' + totalChunks + ' chunks' });
    }

    const combinedBytes = concatByteArrays(chunkFiles.map(f => f.getBlob().getBytes()));
    const finalBlob = Utilities.newBlob(combinedBytes, payload.mimeType || 'application/octet-stream', payload.filename || 'file');
    const result = uploadBlob(finalBlob);

    chunkFiles.forEach(f => f.setTrashed(true));
    chunkFolder.setTrashed(true);

    return result;
  } catch (err) {
    return jsonOut({ success: false, error: 'Reassembly failed: ' + String(err) });
  }
}

function concatByteArrays(arrays) {
  let total = 0;
  arrays.forEach(a => { total += a.length; });
  const result = new Array(total);
  let offset = 0;
  arrays.forEach(a => {
    for (let i = 0; i < a.length; i++) result[offset + i] = a[i];
    offset += a.length;
  });
  return result;
}

function getOrCreateSubfolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
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
