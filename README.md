# ERTHPORTAL

## Architecture

GitHub Pages hosts the frontend. Supabase Free provides username/password authentication, account profiles/status, and a protected admin Edge Function. Google Sheets remains the employee-data source. Google OAuth is used after portal login to authorize the user's assigned Google account to access Sheets.

Account passwords are managed by Supabase Auth and are never stored in the profiles table or GitHub. Admins create accounts and receive a one-time temporary password to share privately. New/reset accounts have `default` status and must change that password before continuing. `inactive` accounts cannot sign in.

## Supabase Setup

1. Create a Supabase project on the Free plan.
2. In **SQL Editor**, run `supabase/migrations/202610020001_profiles.sql`.
3. Deploy the protected `admin-users` Edge Function. With the Supabase CLI installed, run `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, `supabase db push`, and `supabase functions deploy admin-users` from this repository. The function uses Supabase's server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never put the service-role key in the page or GitHub.
4. Bootstrap the first administrator in Supabase **Authentication → Users**: create and confirm a user with email `admin@accounts.erthportal.invalid` and a strong password. Copy that Auth user's UUID. In SQL Editor, insert its profile, replacing the UUID and Google email:

	```sql
	insert into public.profiles (id, username, display_name, google_email, client_name, role, status)
	values ('AUTH_USER_UUID', 'admin', 'Portal Administrator', 'admin@example.com', 'My spreadsheets', 'admin', 'active');
	```

5. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `index.html` through `window.ERTHPORTAL_SUPABASE_URL` and `window.ERTHPORTAL_SUPABASE_ANON_KEY` before its module script. The anon/publishable key is public and safe to include with RLS enabled; never use the service-role key.
6. Publish the updated frontend and `supabase` folder to GitHub Pages.

Usernames are mapped to internal Supabase Auth addresses ending in `@accounts.erthportal.invalid`; users sign in with their username and password, not that generated address. Admins reset passwords by username; the user receives a temporary password and must replace it at next sign-in.

## Google Sheets Setup

Each profile stores the Google email authorized for that username. After portal authentication, the user must authorize that same Google account and connect their own spreadsheet URL. The sheet needs a `PLANTILLA` tab and edit access for that Google account. The OAuth access token stays in memory; the spreadsheet ID is stored in that browser, scoped by Google email.

Enable the Google Sheets API in Google Cloud and create a Web OAuth client. Add `https://ceris-system.github.io` as an authorized JavaScript origin. The Client ID is public; never add a client secret. While the OAuth consent screen is in Testing, add each user's Google account as a test user. Production access to Google's sensitive Sheets scope may require verification; publishing alone does not complete verification.

Branding URLs:

- Homepage: `https://ceris-system.github.io/ERTHPORTAL/`
- Privacy policy: `https://ceris-system.github.io/ERTHPORTAL/privacy.html`
- App name: `ERTH PORTAL`

The portal reads rows 9 onward and uses VCODE in column B as the unique row key. Dates display in uppercase, e.g. `SEPTEMBER 26, 2026`. Updates write only Rate (H), Separation Date (AG), and Status (AH).

Supabase Free has usage limits and may pause projects after extended inactivity. Check the current plan limits before relying on it for production operations.
