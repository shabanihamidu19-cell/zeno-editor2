#!/usr/bin/env bash
# Zeno Editor — one-shot Android setup. Run from the project root after `npm install`.
set -euo pipefail

echo "▶ 1/5 Building web app (Angular production)…"
npm run build

if [ ! -d android ]; then
  echo "▶ 2/5 Adding Android platform…"
  npx cap add android
else
  echo "▶ 2/5 Android platform already exists — skipping add."
fi

echo "▶ 3/5 Installing AndroidManifest.xml with READ/WRITE permissions…"
cp android-overrides/AndroidManifest.xml android/app/src/main/AndroidManifest.xml

echo "▶ 4/5 Generating app icon + splash from resources/ (optional, needs internet)…"
npx --yes @capacitor/assets generate --android \
  --iconBackgroundColor '#0e0e10' --iconBackgroundColorDark '#0e0e10' \
  --splashBackgroundColor '#0e0e10' --splashBackgroundColorDark '#0e0e10' \
  || echo "  (icon generation skipped — default icon will be used)"

echo "▶ 5/5 Syncing web assets into Android project…"
npx cap sync android

echo
echo "✔ Done. Next:"
echo "   npx cap open android        # open in Android Studio, then Build > Build APK(s)"
echo "   (or)  cd android && ./gradlew assembleDebug   # APK: android/app/build/outputs/apk/debug/"
