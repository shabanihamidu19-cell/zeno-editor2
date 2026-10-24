import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'tz.kidcoder.zeno',
  appName: 'Zeno Editor',
  webDir: 'www',
  backgroundColor: '#0e0e10',
  server: {
    androidScheme: 'https',
    cleartext: false
  },
  android: {
    backgroundColor: '#0e0e10',
    allowMixedContent: false
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#0e0e10',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP'
    }
  }
};

export default config;
