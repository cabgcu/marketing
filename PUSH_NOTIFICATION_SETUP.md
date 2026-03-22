# Push Notification Setup Guide

This enables real background push notifications on iOS (16.4+) and all other platforms.

## Step 1: Generate VAPID Keys

Run this in your terminal (requires Node.js):

```bash
npx web-push generate-vapid-keys
```

This will output a public key and private key. Save both.

## Step 2: Set the Public Key in the App

In `index.html`, find this line near the top and paste your public key:

```javascript
const VAPID_PUBLIC_KEY = 'YOUR_PUBLIC_KEY_HERE';
```

## Step 3: Deploy the Supabase Edge Function

1. Install the Supabase CLI if you haven't:
   ```bash
   npm install -g supabase
   ```

2. Link your project:
   ```bash
   supabase link --project-ref qcfntvqvcmshbbpcxmgo
   ```

3. Set the secrets:
   ```bash
   supabase secrets set VAPID_PRIVATE_KEY="your_private_key"
   supabase secrets set VAPID_PUBLIC_KEY="your_public_key"
   supabase secrets set VAPID_SUBJECT="mailto:your-email@example.com"
   ```

4. Deploy the function:
   ```bash
   supabase functions deploy send-push --no-verify-jwt
   ```

## Step 4: Test

1. Open the app on your iPhone (must be added to Home Screen)
2. Go to notification settings and tap "Enable Push Notifications"
3. Have another user send you a notification (assign a card, comment, etc.)
4. Close the app — you should receive a push notification

## How It Works

1. When a user enables notifications, the app subscribes to Web Push via `PushManager` and stores the subscription in Supabase
2. When User A creates a notification for User B, the app calls the `send-push` Edge Function
3. The Edge Function reads User B's push subscription from Supabase and sends a real Web Push notification
4. The service worker (`sw.js`) receives the push event and shows the notification — even when the app is closed

## Requirements

- iOS 16.4+ (for Web Push on iOS)
- App must be installed via "Add to Home Screen" on iOS
- User must grant notification permission
