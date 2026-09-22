/**
 * Minimal local config plugin for react-native-webrtc.
 * Replaces @config-plugins/react-native-webrtc which is broken on some versions.
 */
const {
  withInfoPlist,
  withAndroidManifest,
  AndroidConfig,
  createRunOncePlugin,
} = require('@expo/config-plugins');

function withWebRTCIOS(config, props = {}) {
  return withInfoPlist(config, (cfg) => {
    const camera =
      props.cameraPermission ||
      'Allow $(PRODUCT_NAME) to access your camera';
    const mic =
      props.microphonePermission ||
      'Allow $(PRODUCT_NAME) to access your microphone';

    cfg.modResults.NSCameraUsageDescription =
      cfg.modResults.NSCameraUsageDescription || camera;
    cfg.modResults.NSMicrophoneUsageDescription =
      cfg.modResults.NSMicrophoneUsageDescription || mic;

    // WebRTC requires bitcode disabled (handled by Expo by default on modern SDKs)
    return cfg;
  });
}

function withWebRTCAndroid(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const permissions = [
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.INTERNET',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
    ];

    for (const permission of permissions) {
      AndroidConfig.Permissions.ensurePermission(manifest, permission);
    }

    return cfg;
  });
}

function withWebRTC(config, props = {}) {
  config = withWebRTCIOS(config, props);
  config = withWebRTCAndroid(config);
  return config;
}

module.exports = createRunOncePlugin(withWebRTC, 'localdrop-webrtc', '1.0.0');
