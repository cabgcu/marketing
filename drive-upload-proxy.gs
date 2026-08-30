/**
 * CAB Marketing → Google Drive upload/download proxy
 *
 * This is the script deployed behind GAS_UPLOAD_URL in index.html. Keep this
 * file in sync with whatever is pasted into the actual Apps Script project
 * so the two don't drift.
 */

// 👉 STEP 1: RUN THIS FUNCTION MANUALLY TO FORCE FULL WRITE AUTHORIZATION
function setup() {
  var FOLDER_ID = '1qT_8x_IJ3mDlt_zEW3a17nY5wJaJa_nh';
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var tempFile = folder.createFile("auth_test.txt", "This is a test to force write permissions.", MimeType.PLAIN_TEXT);
  tempFile.setTrashed(true);
  console.log("Full write authorization successful! You can now deploy the web app.");
}

// Reads a file straight off Drive (authenticated as the deploying account)
// and returns it as base64 JSON. Used by the app's video/large-file download
// button. drive.google.com's public export=download URLs return a small
// HTML "can't scan this file for viruses" page instead of the real bytes for
// videos and other unscannable types when fetched anonymously — reading the
// file server-side via DriveApp avoids that flow entirely.
function doGet(e) {
  try {
    var fileId = e.parameter.id;
    if (!fileId) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Missing id parameter' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var file = DriveApp.getFileById(fileId);
    var blob = file.getBlob();

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      name: file.getName(),
      mimeType: blob.getContentType() || 'application/octet-stream',
      base64: Utilities.base64Encode(blob.getBytes())
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    var FOLDER_ID = '1qT_8x_IJ3mDlt_zEW3a17nY5wJaJa_nh';
    var params = JSON.parse(e.postData.contents);

    // --- HANDLE DELETE ---
    if (params.action === 'delete') {
      var fileToDelete = DriveApp.getFileById(params.fileId);
      fileToDelete.setTrashed(true); // Moves the file to Google Drive trash
      return ContentService.createTextOutput(JSON.stringify({ success: true }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // --- HANDLE UPLOAD ---
    var folder = DriveApp.getFolderById(FOLDER_ID);
    var decodedData = Utilities.base64Decode(params.base64);
    var blob = Utilities.newBlob(decodedData, params.mimeType, params.filename);
    var file = folder.createFile(blob);

    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      url: file.getUrl(),
      name: file.getName()
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doOptions(e) {
  return ContentService.createTextOutput("").setMimeType(ContentService.MimeType.TEXT);
}
