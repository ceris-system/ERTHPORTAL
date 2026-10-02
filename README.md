# ERTHPORTAL

## Private Plantilla connection

Plantilla reads and updates use Google Apps Script so each signed-in Google account stores its own spreadsheet URL and accesses that spreadsheet with its own Google permissions. Do not publish employee spreadsheets to the web.

1. Create a Google Apps Script project at [script.google.com](https://script.google.com/).
2. Replace the project `Code.gs` contents with this repository's `Code.gs`.
3. Add an HTML file named `index` and put this repository's `index.html` contents in it.
4. Deploy as a web app. Set **Execute as** to **User accessing the web app** and restrict **Who has access** to the authorized Google Workspace users or accounts who should use the portal. Do not allow anonymous access.
5. Each user opens the deployed web app, signs in to Google, signs in to the portal preview, opens **PLANTILLA**, chooses **Connect my sheet**, and enters their own spreadsheet URL. The spreadsheet must contain a tab named `PLANTILLA`, and the user's Google account must have edit access to it.

The connector reads rows 9 onward and uses VCODE in column B as the unique record key. Updates change only Rate (H), Separation Date (AG), and Status (AH); other cells and formulas in those rows are left untouched. The portal displays dates as `SEPTEMBER 26, 2026`.

The portal's username/password form is still a local preview and is not authentication. Google sign-in and the Apps Script deployment restrictions control access to each user's spreadsheet. Live spreadsheet access cannot be tested from the local file preview.
