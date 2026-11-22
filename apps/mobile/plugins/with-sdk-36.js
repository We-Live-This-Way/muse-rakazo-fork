// Build against the Android SDK platform actually available here (API 36).
// Expo 58 defaults to compileSdk 37, but no API 37 platform is published in
// any SDK channel sdkmanager knows (stable, beta, dev and canary all top out
// at API 36), so the build fails with "Failed to install platforms;android-37.0".
// Expo's root plugin only sets these versions when rootProject.ext lacks them
// (setIfNotExist), so defining them in the root build.gradle before the plugin
// is applied wins. Build tools 36.0.0 and NDK 27.1.12297006 are installed.
// Every Expo 58 module and AndroidX Compose 1.12 stamp minCompileSdk 37 in
// their AAR metadata, so AGP's checkReleaseAarMetadata also fails; disable
// that check (android.experimental.disableCompileSdkChecks, the AGP escape
// hatch for building against a lower compileSdk than a dependency declares).
// The libraries are built to run on devices up to API 36, and the fork's own
// code references no API 37 symbols. (android.suppressUnsupportedCompileSdk
// does NOT do this: it only suppresses warnings when the project's own
// compileSdk is newer than AGP supports.)
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "// fork: build against installed SDK 36 (API 37 platform unpublished)";
const PROPS_MARKER =
  "# fork: libraries declare minCompileSdk 37; no API 37 platform is published,\n# so disable AGP's compileSdk check (android.experimental.disableCompileSdkChecks)";
const PROPS_LINE = "android.experimental.disableCompileSdkChecks=true";

module.exports = function withSdk36(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const buildGradle = path.join(cfg.modRequest.projectRoot, "android", "build.gradle");
      const text = fs.readFileSync(buildGradle, "utf8");
      if (!text.includes(MARKER)) {
        const next = text.replace(
          'apply plugin: "expo-root-project"',
          `${MARKER}\next {\n  compileSdkVersion = 36\n  buildToolsVersion = "36.0.0"\n}\n\napply plugin: "expo-root-project"`,
        );
        if (next === text) {
          throw new Error(
            "with-sdk-36: could not find expo-root-project apply line in android/build.gradle",
          );
        }
        fs.writeFileSync(buildGradle, next);
      }
      const gradleProps = path.join(cfg.modRequest.projectRoot, "android", "gradle.properties");
      const props = fs.readFileSync(gradleProps, "utf8");
      if (!props.includes(PROPS_LINE)) {
        fs.writeFileSync(
          gradleProps,
          `${props.replace(/\s+$/, "")}\n\n${PROPS_MARKER}\n${PROPS_LINE}\n`,
        );
      }
      return cfg;
    },
  ]);
};
