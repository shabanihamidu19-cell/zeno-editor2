# Zeno Editor — AI Powered Code Editor (Capacitor 6 + Ionic Angular + Monaco)

Mhariri wa msimbo wa simu unaofanana na Spck, ukiwa na **Zeno AI Extension** inayoona tabs zote, faili za mradi, makosa ya Monaco na matokeo ya terminal.

## Kuendesha (hatua 4)

```bash
npm install
bash scripts/setup-android.sh     # build ya Angular + cap add android + AndroidManifest + cap sync
npx cap open android              # fungua Android Studio → Build > Build APK(s)
```

Au APK ya debug moja kwa moja: `cd android && ./gradlew assembleDebug`
(faili: `android/app/build/outputs/apk/debug/app-debug.apk`).

Hatua za mkono (kama hutaki script): `npm run build` → `npx cap add android` → nakili
`android-overrides/AndroidManifest.xml` kwenda `android/app/src/main/AndroidManifest.xml` → `npx cap sync android` → `npx cap open android`.

**Bila kompyuta:** weka mradi huu kwenye GitHub. Workflow ya `.github/workflows/android.yml` itatengeneza APK (Actions → Artifacts → `zeno-editor-debug-apk`).

## Vipengele

| Kipengele | Mahali |
|---|---|
| File Explorer (create / rename / delete, folders), hifadhi `Documents/ZenoProjects/` | `services/filesystem.service.ts`, `editor.page.*` |
| Tabs nyingi, swipe juu kufunga tab | `editor.page.*` |
| Monaco: html/css/js/ts/json/py, IntelliSense, minimap, VS Dark | `editor.page.ts` |
| Live Preview (iframe, auto-reload) + Split view (◧) | `editor.page.ts` |
| Terminal: JS (`console.log`), TypeScript, Python (Pyodide v0.23.4 CDN) | `editor.page.ts` |
| Auto-save (sekunde 1.5) + Save kwa mkono (💾 / Ctrl+S) | `editor.page.ts` |
| Zeno AI: Layer 1 offline + Layer 2 online, Auto Debug Mode, diff + Apply Fix | `services/ai-vision.service.ts` |

## Zeno AI — jinsi inavyofanya kazi

* **Maono (Vision):** `getAllOpenFilesContent()` husoma tabs zote; payload hubeba `context` (orodha ya faili), `currentFile`, `currentCode`, `errorMarkers`, `terminalOutput`, `userGoal`.
* **Layer 1 (bila mtandao):** `monaco.editor.getModelMarkers()` + linter zetu: mabano yasiyofungwa (`{ ( [`), `:` ya Python, `;` ya JS, tags za HTML zisizofungwa, JSON (trailing comma / mabano). Marekebisho hufanywa kwa `editor.executeEdits()` na toast: *"AI Auto-Fixed: Added missing }"*.
* **Layer 2 (mtandaoni):** weka API key kwenye ⚙ ndani ya paneli ya AI (endpoint yoyote inayoendana na OpenAI). Jibu lenye code block linaonyeshwa kama **diff** na kitufe cha **Apply Fix**.
* **Auto Debug Mode:** inasikiliza `onDidChangeModelContent` kwa debounce ya 1.5s. Ikiwa **OFF**, linter bado zinaonyesha makosa lakini hazibadilishi msimbo wako.

## Mambo ya kujua

* **Hifadhi:** programu hujaribu `Documents/ZenoProjects`; kama Android haitoi ruhusa (mfano Android 11+), hutumia folda ya ndani ya app (`App Data/ZenoProjects`). Eneo halisi linaonekana chini ya sidebar.
* **Python** inahitaji mtandao mara ya kwanza ili kupakua Pyodide.
* Funguo za AI huhifadhiwa kwenye kifaa chako tu (localStorage).
# zeno-editor2
