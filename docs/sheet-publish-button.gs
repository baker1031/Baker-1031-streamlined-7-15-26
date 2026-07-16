/**
 * Baker 1031 — "Publish to website" menu for the Master Listings sheet.
 *
 * One-time setup (about 60 seconds):
 * 1. Open the Master Listings Google Sheet
 * 2. Extensions → Apps Script
 * 3. Delete any placeholder code, paste this whole file, click Save (disk icon)
 * 4. Reload the spreadsheet tab
 * 5. A "Baker 1031" menu appears next to Help. First use asks you to
 *    authorize the script (it only calls the Netlify rebuild URL).
 *
 * After that: edit the sheet, then Baker 1031 → Publish to website.
 * Changes are live at baker1031.com about 2 minutes later.
 * (Even without pressing it, the site republishes automatically every
 * night at 2:00 AM Pacific.)
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Baker 1031')
    .addItem('Publish to website', 'publishToWebsite')
    .addToUi();
}

function publishToWebsite() {
  UrlFetchApp.fetch('https://api.netlify.com/build_hooks/6a5927900757efcb0ebc63f9', {
    method: 'post',
    payload: '{}'
  });
  SpreadsheetApp.getActiveSpreadsheet()
    .toast('Rebuild started — the website updates in about 2 minutes.', 'Baker 1031', 8);
}
