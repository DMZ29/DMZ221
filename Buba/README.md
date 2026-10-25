# Buba marketplace

Buba is a small European marketplace prototype with Supabase email/password
authentication, seller onboarding through Stripe Connect Express, and payment
checkout through Stripe Checkout. The server uses EUR prices and creates
destination charges for one connected seller per checkout.

## Requirements

- Node.js 20 or newer
- A Supabase project
- A Stripe account with Connect enabled
- Stripe test-mode keys for local development

## Configure Supabase

1. Create a Supabase project and run [`supabase/schema.sql`](./supabase/schema.sql)
   in its SQL Editor.
2. In **Authentication → Providers**, enable email/password and email
   confirmation, and make sure new user sign-ups are enabled.
3. In **Authentication → URL Configuration**, set the Site URL to
   `http://localhost:4242` and add `http://localhost:4242/**` to the redirect
   URL allow list. Add your production HTTPS origin and its redirect paths
   before deploying.
4. Configure a trusted SMTP provider in Supabase before inviting real users;
   the default email service is intended for testing.
5. Copy `.env.example` to `.env` and set these Supabase values from **Project
   Settings → API**:

   ```text
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=your-publishable-or-anon-key
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-secret
   ```

   The service-role key is server-only: never put it in `index.html`, commit it,
   or share it in chat. The URL and publishable/anon key are used to initialize
   the browser sign-up, sign-in, email confirmation, and password-reset flows.

The SQL trigger copies sign-up name and delivery details into the private
`profiles` table. Row-level security limits profile and order visibility.
Products and orders are written by the server with the service-role key after
it verifies the Supabase access token; never expose that key.

## Configure Stripe

1. Enable Stripe Connect and Express connected accounts for the countries you
   intend to serve. Sellers complete Stripe's hosted identity and payout
   onboarding before their listings are published.
2. Enable the payment methods needed by your Stripe platform account. Buba
   requests cards (which can surface Apple Pay or Google Pay when eligible),
   SEPA Direct Debit, iDEAL, Bancontact, and EU bank transfer. Stripe decides
   which methods are available for the customer's country and account.
3. Copy `.env.example` to `.env` and add the Supabase and Stripe settings.
   Keep `.env` private; it is excluded from Git.
4. Start Stripe's local webhook forwarder:

   ```powershell
   stripe listen --forward-to localhost:4242/api/stripe-webhook
   ```

   Copy the signing secret printed by the Stripe CLI to `STRIPE_WEBHOOK_SECRET`.
5. For production, configure a Stripe webhook for
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, and
   `checkout.session.expired`, targeting
   `https://your-domain.example/api/stripe-webhook`.

`PLATFORM_FEE_PERCENT` defaults to `0`. With destination charges, Stripe
processing fees are charged to the platform unless your Stripe configuration
states otherwise. Set a fee only after deciding your marketplace terms.
Check your local Stripe account's method/country eligibility before advertising
any payment method. Wallet availability is automatic and device-dependent.

## Run locally

From this folder:

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

Open `http://localhost:4242`. The site returns a clear setup error until the
required environment settings and Supabase schema are in place. Do not open
`index.html` directly as a `file://` URL; the sign-up and login flows need the
Node server to provide the Supabase configuration. Use Stripe test-mode
credentials and test payment methods first.

## Run the Android and iOS app

The native app is in [`mobile/`](./mobile/). It uses the same Buba server,
Supabase authentication, product catalog, seller onboarding, and Stripe-hosted
checkout as the website.

1. Start the server using the steps above.
2. In a second terminal, configure the app's API origin:

   ```powershell
   Copy-Item mobile/.env.example mobile/.env
   ```

   Set `EXPO_PUBLIC_API_URL` in `mobile/.env` to the server address. Use
   `http://localhost:4242` for the iOS simulator, `http://10.0.2.2:4242` for
   the standard Android emulator, or your computer's LAN address for a phone
   on the same Wi-Fi network. Use HTTPS for production.
3. Start Expo from `mobile/`:

   ```powershell
   Set-Location mobile
   npm install
   npm start
   ```

   Scan the QR code with Expo Go, or run `npm run android` with Android Studio
   and an emulator configured. An iOS simulator build requires macOS and Xcode;
   iOS development on Windows can use Expo Go on a physical iPhone or an EAS
   cloud build.

For store-ready cloud builds, sign in to Expo from `mobile/` and link the app
to an EAS project:

```powershell
npx eas-cli@latest login
npx eas-cli@latest init
```

Set the public API origin for production builds in the linked EAS project's
`production` environment. This must be the deployed HTTPS Buba server; do not
use localhost for store builds:

```powershell
npx eas-cli@latest env:set --name EXPO_PUBLIC_API_URL --value https://api.your-domain.example --environment production --visibility plaintext
npx eas-cli@latest build --platform all --profile production
```

EAS will prompt to create/store the Android signing key and to connect an Apple
Developer account for iOS signing. Apple Developer Program and Google Play
developer accounts are required for store releases. Google Play submission
also needs Play Console app setup and upload credentials; iOS submission needs
an App Store Connect app record. Builds are configured as an Android app
bundle (`.aab`) and iOS App Store archive. The preview profile produces an installable Android APK and an iOS Simulator
build without store developer accounts. Use
`npx eas-cli@latest build --platform all --profile preview` to build both.
Installing an iOS build on a physical iPhone still requires Apple signing and
registered devices.

Supabase **Authentication → URL Configuration** must allow the native callback
URI `buba://auth/callback` for sign-up verification and password reset links.

The checkout opens Stripe's secure hosted payment page. The app checks the
order status with the Buba server when the hosted browser closes. Native release
builds still need Android/iOS signing and the respective store accounts.

## Current scope and operational notes

- Sign-up collects first and last name, email, delivery address, town/city,
  postcode, country, and password confirmation. Names are saved together as the
  customer's full name for profiles and delivery. Supabase sends the
  verification and reset emails; Buba does not store passwords.
- Seller listings are saved in Supabase only after Stripe Connect onboarding is
  complete. The catalog uses text-only listings at this stage.
- Checkout prices are loaded and validated server-side; changing browser cart
  prices cannot change the amount charged. Checkout is limited to one seller at
  a time, as Stripe destination charges have one connected destination.
- Stripe Checkout handles card authentication and the supported payment
  methods. Buba never receives card numbers, wallet credentials, or bank
  credentials.
- The buyer's sign-up delivery address is saved to the order. This version does
  not calculate or collect shipping charges; buyers and sellers must agree
  shipping separately before ordering.
- The order is marked paid only after Stripe confirms payment. Bank transfers
  may remain pending until Stripe reports settlement.
- The platform must complete its own Stripe business verification and comply
  with applicable marketplace, tax, privacy, consumer-protection, and
  payment-services requirements before production launch.
