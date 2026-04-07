/**
 * review-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Copy this file into the comediq-app React Native project, e.g.:
 *   comediq-app/src/utils/reviewManager.js
 *
 * Dependencies (install in comediq-app):
 *   npx expo install expo-store-review
 *
 * Usage — call checkAndRequestReview() after a set is processed:
 *   import { checkAndRequestReview } from '../utils/reviewManager';
 *   // inside the results screen, after the set data arrives:
 *   await checkAndRequestReview(totalSetsCount);
 *
 * If you ever have a "Tap here to rate us" button in the UI, wire it to:
 *   import { openStorePage } from '../utils/reviewManager';
 *   await openStorePage();
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as StoreReview from 'expo-store-review';
import { Linking, Platform } from 'react-native';

// ── CONFIG ────────────────────────────────────────────────────────────────────
// Fill these in when the app is published to the stores.
const APP_STORE_ID = 'YOUR_APP_STORE_ID';          // numeric Apple App ID, e.g. '6450123456'
const PLAY_STORE_PACKAGE = 'com.comediq.hear';     // Android package name

// Must match the backend constant in server.js (REVIEW_MILESTONES).
// The prompt fires only when the user's recorded-set count hits one of these.
const REVIEW_MILESTONES = [5, 10, 20];

// Backend base URL — update to your Railway deployment.
// In dev you can point this at your local machine IP for testing.
const BACKEND_URL = process.env.EXPO_PUBLIC_API_URL || 'https://your-app.up.railway.app';

// ── MAIN ENTRY POINT ──────────────────────────────────────────────────────────

/**
 * Call this after every set is saved/processed.
 *
 * @param {number} setsCount  Total sets the user has recorded (including this one).
 *                            Fetch this from your sets list length or the API response.
 *
 * Flow:
 *   1. Bail early if setsCount is not one of the milestone numbers (fast, no network).
 *   2. Ask the backend whether we're still eligible (rate limit / already reviewed).
 *   3a. If eligible — try the native StoreReview sheet.
 *   3b. If StoreReview is unavailable — open the store page as a fallback.
 *   4. Log the request with the backend so the rate-limit counter stays accurate.
 */
export async function checkAndRequestReview(setsCount) {
  // Step 1: fast milestone guard — no network call needed.
  if (!REVIEW_MILESTONES.includes(setsCount)) return;

  try {
    // Step 2: ask the backend.
    const res = await fetch(`${BACKEND_URL}/review/status`);
    if (!res.ok) return;
    const { eligible } = await res.json();
    if (!eligible) return;

    // Step 3: try native prompt first.
    const nativeAvailable = await StoreReview.isAvailableAsync();

    if (nativeAvailable) {
      // requestReview() presents the OS-native sheet.
      // iOS/Android each enforce their own hard caps on how often this actually
      // appears — calling it does NOT guarantee the sheet shows.
      await StoreReview.requestReview();

      // Log that we showed the prompt (or attempted to).
      // Do this regardless of whether the sheet was actually displayed,
      // because we have no reliable callback for that.
      await _logReviewRequested();
    } else {
      // Step 3b: native sheet unavailable (simulator, too-old OS, etc.)
      // Open the store page so the user can still leave a review.
      await openStorePage();
      // Also log the fallback as a request so it counts toward rate limiting.
      await _logReviewRequested();
    }
  } catch (err) {
    // Never crash the app over a review prompt.
    console.warn('[ReviewManager] checkAndRequestReview failed:', err?.message);
  }
}

// ── STORE PAGE DEEP-LINK ──────────────────────────────────────────────────────

/**
 * Opens the app's store page directly to the Reviews tab.
 *
 * Use this for an explicit "Rate the app" button in your UI.
 * After the user returns from the store, call markReviewCompleted() so we
 * stop prompting them.
 */
export async function openStorePage() {
  const { nativeUrl, webUrl } = _storeUrls();

  try {
    const canOpenNative = await Linking.canOpenURL(nativeUrl);
    await Linking.openURL(canOpenNative ? nativeUrl : webUrl);
  } catch {
    // Last-resort fallback: always works.
    await Linking.openURL(webUrl);
  }
}

// ── MARK COMPLETED ────────────────────────────────────────────────────────────

/**
 * Call this when you have a strong signal the user left a review.
 *
 * Signals you can use:
 *   - The user tapped a "Yes, I left a review" confirmation button in your UI.
 *   - The app came back to the foreground after openStorePage() was called
 *     and the user was on the Reviews tab for >10 seconds.
 *
 * Once this is called the backend will never return eligible=true again.
 */
export async function markReviewCompleted() {
  try {
    await fetch(`${BACKEND_URL}/review/completed`, { method: 'POST' });
  } catch (err) {
    console.warn('[ReviewManager] markReviewCompleted failed:', err?.message);
  }
}

// ── PRIVATE HELPERS ───────────────────────────────────────────────────────────

async function _logReviewRequested() {
  try {
    await fetch(`${BACKEND_URL}/review/requested`, { method: 'POST' });
  } catch (err) {
    console.warn('[ReviewManager] _logReviewRequested failed:', err?.message);
  }
}

function _storeUrls() {
  if (Platform.OS === 'ios') {
    return {
      // itms-apps:// opens the App Store app directly — preferred.
      nativeUrl: `itms-apps://itunes.apple.com/app/id${APP_STORE_ID}?action=write-review`,
      // Fallback for when the store app can't be launched (e.g. simulator).
      webUrl: `https://apps.apple.com/app/id${APP_STORE_ID}?action=write-review`,
    };
  }

  return {
    // market:// opens the Play Store app directly.
    nativeUrl: `market://details?id=${PLAY_STORE_PACKAGE}&showAllReviews=true`,
    // Fallback for devices without the Play Store (e.g. emulator).
    webUrl: `https://play.google.com/store/apps/details?id=${PLAY_STORE_PACKAGE}&showAllReviews=true`,
  };
}
