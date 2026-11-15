jest.mock('expo-router', () => require('./src/test/router-mock'));
jest.mock('expo-camera', () => require('./src/test/camera-mock'));
jest.mock('react-native-webview', () => require('./src/test/webview-mock'));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('expo-asset', () => ({ Asset: { fromModule: () => ({ downloadAsync: async () => undefined, localUri: 'file:///cache/share.png', uri: 'asset://share.png' }) } }));
jest.mock('expo-file-system', () => ({ File: class {}, Paths: { cache: '/cache' } }));
