# ERTHPORTAL

## Architecture

GitHub Pages hosts the frontend. Supabase Free provides username/password authentication, account profiles/status, and protected Edge Functions. Google Sheets remains the employee-data source. Users access assigned PLANTILLA sheets through the `google-sheets-api` Edge Function, which authenticates to Google as a server-side service account; users do not need to authorize Google individually.

Account passwords are managed by Supabase Auth and are never stored in the profiles table or GitHub. Admins create accounts and receive a one-time temporary password to share privately. New/reset accounts have `default` status and must choose a username and new password before continuing. `inactive` accounts cannot sign in; the login page directs locked users to the administrator.

## Supabase Setup

1. Create a Supabase project on the Free plan.
2. In **SQL Editor**, run `supabase/migrations/202610020001_profiles.sql`, `supabase/migrations/202610050001_profile_photo_sheet.sql`, and `supabase/migrations/202610050002_dashboard_assignments.sql` in that order.
3. Deploy the protected `admin-users` and `google-sheets-api` Edge Functions. With the Supabase CLI installed, run `supabase login`, `supabase link --project-ref YOUR_PROJECT_REF`, `supabase db push`, `supabase functions deploy admin-users`, and `supabase functions deploy google-sheets-api` from this repository. The functions use Supabase's server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never put the service-role key in the page or GitHub.
4. Bootstrap the first administrator in Supabase **Authentication → Users**: create and confirm a user with email `admin@accounts.erthportal.invalid` and a strong password. Copy that Auth user's UUID. In SQL Editor, insert its profile, replacing the UUID and Google email:

	```sql
	insert into public.profiles (id, username, display_name, google_email, client_name, role, status)
	values ('AUTH_USER_UUID', 'admin', 'Portal Administrator', 'admin@example.com', 'My spreadsheets', 'admin', 'active');
	```

5. Paste your live values into the page config in `index.html` using the global variables `window.ERTHPORTAL_SUPABASE_URL` and `window.ERTHPORTAL_SUPABASE_ANON_KEY` before the app script runs. The anon/publishable key is public and safe to include with RLS enabled; never use the service-role key. `window.ERTHPORTAL_GOOGLE_CLIENT_ID` is only needed if an administrator uses the optional personal-sheet connection flow. You can also define these values before `index.html` loads in a hosted environment if you prefer to keep the values outside the source file.
6. Publish the updated frontend and `supabase` folder to GitHub Pages.

Usernames are mapped to internal Supabase Auth addresses ending in `@accounts.erthportal.invalid`; users sign in with their username and password, not that generated address. Admins reset passwords by username; the user receives a temporary password and must choose a username and replacement password at next sign-in. Users can also update their own username in **My Account**. The login page can remember a username on the current device, but never stores a password. “Forgot password?” asks for the username and explains that the administrator must issue a temporary password; password recovery is not allowed from a username alone.

Admins add users from the dashboard's **Add User** control. From the account list, administrators can set an individual status or select multiple accounts and bulk-apply `active`, `inactive`, or `default` status. Setting `default` requires the user to set a username and password on next sign-in. The initial password is set by the admin, and dashboard spreadsheet URLs are assigned per user from each dashboard's **Assign spreadsheet URL to user** action. The assignment migration and updated Edge Function must be deployed for these per-user URLs to sync across devices.

## Google Sheets service account setup

To make assigned PLANTILLA sheets plug-and-play for users, configure the service account once:

1. In Google Cloud, enable the Google Sheets API and create a service account. Create a private key for it and keep the downloaded key out of the repository.
2. In Supabase **Project Settings → Edge Functions → Secrets**, set `GOOGLE_SERVICE_ACCOUNT_EMAIL` to the service account email and `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` to the private key's `private_key` value. These credentials must remain server-side; never add them to `index.html`, GitHub, or a user account.
3. Share each private spreadsheet with that service account email as an **Editor**. This one-time file sharing lets the portal read and update the assigned sheet without prompting each user to authorize Google. Do not make employee data public.
4. Deploy `google-sheets-api` as shown above. In the portal, assign each user's spreadsheet URL to the PLANTILLA dashboard. The sheet must contain a `PLANTILLA` tab.

The Edge Function checks the signed-in portal account and only serves spreadsheets assigned to that account. Administrators previewing a user portal are restricted to that user's assignment as well. The function reads rows 9 onward and updates only Rate (H), Separation Date (AG), and Status (AH).

The optional administrator-only **Connect my sheet** flow still uses browser-based Google OAuth. If using it, set a Web OAuth client ID in `window.ERTHPORTAL_GOOGLE_CLIENT_ID` and add `https://ceris-system.github.io` as an authorized JavaScript origin. Ordinary users do not need this OAuth client or individual Google authorization for assigned PLANTILLA access.

## Deployment config checklist

- Supabase project URL: `https://<project-ref>.supabase.co`
- Supabase anon key: from `Project Settings → API`
- Google service-account email and private key set as Supabase Edge Function secrets
- Each private assigned PLANTILLA sheet shared with the service-account email as Editor
- Optional Google OAuth client ID only if an administrator uses **Connect my sheet**

Branding URLs:

- Homepage: `https://ceris-system.github.io/ERTHPORTAL/`
- Privacy policy: `https://ceris-system.github.io/ERTHPORTAL/privacy.html`
- App name: `ERTH PORTAL`

The portal reads rows 9 onward and uses VCODE in column B as the unique row key. Dates display in uppercase, e.g. `SEPTEMBER 26, 2026`. Updates write only Rate (H), Separation Date (AG), and Status (AH).

Supabase Free has usage limits and may pause projects after extended inactivity. Check the current plan limits before relying on it for production operations.
