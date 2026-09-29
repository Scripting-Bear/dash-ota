import { describe, expect, it, jest } from '@jest/globals';

// The entry resolves the TurboModule at import time, so the registry has to answer before the
// module graph loads. Mocked by its own path, which is the same module the entry reaches.
jest.mock('../NativeDashOta', () => ({ __esModule: true, default: {} }));

// Imported by package name on purpose: that is what exercises `customExportConditions` in the
// jest config. Every other suite imports by relative path, so a broken condition stayed
// invisible — the scaffold's `<%- project.sourceCondition -%>` placeholder shipped unrendered
// and nothing failed.
import * as entry from 'react-native-dash-ota';

/** Every value the package promises to export. Types are erased, so only values appear here. */
const PUBLIC_VALUES = [
  'DEFAULT_UI_COPY',
  'DashOtaProvider',
  'STORAGE_KEYS',
  'consoleLogger',
  'isDeviceKeyHardwareBacked',
  'noopIntegrityAttestor',
  'noopTransportSecurity',
  'useOtaUpdate',
];

describe('the package entry resolves through the source export condition', () => {
  it('exports exactly the documented public surface', () => {
    expect(Object.keys(entry).sort()).toEqual(PUBLIC_VALUES);
  });

  it('does not leak the native module', () => {
    expect(entry).not.toHaveProperty('DashOta');
    expect(entry).not.toHaveProperty('default');
  });
});
