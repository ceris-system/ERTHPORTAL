# ERTHPORTAL

## Architecture

GitHub Pages hosts the frontend. Supabase Free provides username/password authentication, account profiles/status, and a protected admin Edge Function. Google Sheets remains the employee-data source. Google OAuth is used after portal login to authorize the user's assigned Google account to access Sheets.

Account passwords are managed by Supabase Auth and are never stored in the profiles table or GitHub. Admins create accounts and receive a one-time temporary password to share privately. New/reset accounts have `default` status and must change that password before continuing. `inactive` accounts cannot sign in.

## Supabase Setup

1. Create a Supabase project on the Free plan.
2. In **SQL Editor**, run `supabase/migrations/202610020001_profiles.sql`, then `supabase/migrations/202610050001_profile_photo_sheet.sql` to add photo and spreadsheet assignments to an existing profile table.
3. Deploy the protected `admin-users` Edge Function. With the Supabase CLI installed, run `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, `supabase db push`, and `supabase functions deploy admin-users` from this repository. The function uses Supabase's server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never put the service-role key in the page or GitHub.
4. Bootstrap the first administrator in Supabase **Authentication → Users**: create and confirm a user with email `admin@accounts.erthportal.invalid` and a strong password. Copy that Auth user's UUID. In SQL Editor, insert its profile, replacing the UUID and Google email:

	```sql
	insert into public.profiles (id, username, display_name, google_email, client_name, role, status)
	values ('AUTH_USER_UUID', 'admin', 'Portal Administrator', 'admin@example.com', 'My spreadsheets', 'admin', 'active');
	```

5. Paste your live values into the page config in `index.html` using the global variables `window.ERTHPORTAL_SUPABASE_URL`, `window.ERTHPORTAL_SUPABASE_ANON_KEY`, and `window.ERTHPORTAL_GOOGLE_CLIENT_ID` before the app script runs. The anon/publishable key is public and safe to include with RLS enabled; never use the service-role key. You can also define them before `index.html` loads in a hosted environment if you prefer to keep the values outside the source file.
6. Publish the updated frontend and `supabase` folder to GitHub Pages.

Usernames are mapped to internal Supabase Auth addresses ending in `@accounts.erthportal.invalid`; users sign in with their username and password, not that generated address. Admins reset passwords by username; the user receives a temporary password and must replace it at next sign-in.

## Deployment config checklist

- Supabase project URL: `https://<project-ref>.supabase.co`
- Supabase anon key: from `Project Settings → API`
- Google OAuth client ID: from `Google Cloud Console → APIs & Services → Credentials`
- Authorized JavaScript origin: `https://ceris-system.github.io`
- OAuth redirect/user flow remains within the same app and uses the Google sign-in flow inside the portal

Use the exact same values for all users because the portal authenticates through the shared GitHub Pages app while each user still connects to their own personal spreadsheet after sign-in.

## Google Sheets Setup

Each profile stores the Google email authorized for that username. After portal authentication, the user must authorize that same Google account and connect their own spreadsheet URL. The sheet needs a `PLANTILLA` tab and edit access for that Google account. The OAuth access token stays in memory; the spreadsheet ID is stored in that browser, scoped by Google email.

Enable the Google Sheets API in Google Cloud and create a Web OAuth client. Add `https://ceris-system.github.io` as an authorized JavaScript origin. The Client ID is public; never add a client secret. While the OAuth consent screen is in Testing, add each user's Google account as a test user. Production access to Google's sensitive Sheets scope may require verification; publishing alone does not complete verification.

Branding URLs:

- Homepage: `https://ceris-system.github.io/ERTHPORTAL/`
- Privacy policy: `https://ceris-system.github.io/ERTHPORTAL/privacy.html`
- App name: `ERTH PORTAL`

The portal reads rows 9 onward and uses VCODE in column B as the unique row key. Dates display in uppercase, e.g. `SEPTEMBER 26, 2026`. Updates write only Rate (H), Separation Date (AG), and Status (AH).

Supabase Free has usage limits and may pause projects after extended inactivity. Check the current plan limits before relying on it for production operations.
