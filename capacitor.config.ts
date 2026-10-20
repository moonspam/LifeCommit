import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.lifecommit.app",
  appName: "LifeCommit",
  webDir: "out",
  loggingBehavior: "none", // "production" logged plugin results (incl. the SQLCipher key) in release builds
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: true,
      androidBiometric: {
        biometricAuth: false,
      },
    },
  },
};

export default config;
