# ERTHPORTAL

## GitHub Pages and Google Sheets

The GitHub Pages site is the frontend. It connects directly to the Google Sheets API using Google OAuth; no Apps Script project or server-side secret is needed. Each person signs in with their Google account and connects their own spreadsheet. Never publish employee data or put a client secret in this repository.

### Google Cloud setup

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Sheets API** for the project.
3. Configure the Google Auth Platform consent screen for the people who will use the portal. During testing, add each tester as a test user. Google may require OAuth verification before general external use because the Sheets permission is sensitive.
4. Create an OAuth client ID with application type **Web application**. Add `https://ceris-system.github.io` as an authorized JavaScript origin.
5. Set the OAuth **client ID** in `GOOGLE_OAUTH_CLIENT_ID` near the top of the page's JavaScript, or define `window.ERTHPORTAL_GOOGLE_CLIENT_ID` before the module script runs. The client ID is public configuration; never add a client secret to the page.
6. Publish the updated `index.html` to the GitHub Pages source branch. The live site is `https://ceris-system.github.io/ERTHPORTAL/`.

Each user opens the site, chooses **Continue with Google**, opens **PLANTILLA**, and connects their spreadsheet URL. The sheet must contain a tab named `PLANTILLA`, and that Google account needs edit permission. The sheet URL is stored in that browser, scoped by the signed-in Google email; the OAuth access token stays in memory and is not stored in local storage.

The portal reads rows 9 onward and uses VCODE in column B as the unique row key. It displays dates in uppercase, for example `SEPTEMBER 26, 2026`. Updates write only Rate (H), Separation Date (AG), and Status (AH). The signed-in user's Google permissions protect their sheet.

This GitHub version uses Google sign-in instead of the preview username/password form. Account access and revocation are controlled by Google; this page does not implement a separate username/password or ACTIVE/INACTIVE/DEFAULT account directory.
