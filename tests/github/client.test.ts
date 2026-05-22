import { describe, expect, it } from 'vitest';
import { loadGithubAppConfig } from '../../src/github/client.js';

const VALID_PEM = '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n';

describe('loadGithubAppConfig', () => {
  it('accepts inline private key', () => {
    const config = loadGithubAppConfig({
      KANBEI_APP_ID: '12345',
      KANBEI_APP_INSTALLATION_ID: '67890',
      KANBEI_APP_PRIVATE_KEY: VALID_PEM,
    });
    expect(config).toEqual({
      appId: 12345,
      installationId: 67890,
      privateKey: VALID_PEM,
    });
  });

  it('reads the private key from a file path when provided', () => {
    const reads: string[] = [];
    const config = loadGithubAppConfig(
      {
        KANBEI_APP_ID: '1',
        KANBEI_APP_INSTALLATION_ID: '2',
        KANBEI_APP_PRIVATE_KEY_PATH: '/some/path.pem',
      },
      (path) => {
        reads.push(path);
        return VALID_PEM;
      },
    );
    expect(reads).toEqual(['/some/path.pem']);
    expect(config.privateKey).toBe(VALID_PEM);
  });

  it('throws when KANBEI_APP_ID is missing', () => {
    expect(() =>
      loadGithubAppConfig({
        KANBEI_APP_INSTALLATION_ID: '2',
        KANBEI_APP_PRIVATE_KEY: VALID_PEM,
      }),
    ).toThrow(/KANBEI_APP_ID/);
  });

  it('throws when KANBEI_APP_ID is not a positive integer', () => {
    expect(() =>
      loadGithubAppConfig({
        KANBEI_APP_ID: 'abc',
        KANBEI_APP_INSTALLATION_ID: '2',
        KANBEI_APP_PRIVATE_KEY: VALID_PEM,
      }),
    ).toThrow(/KANBEI_APP_ID/);
  });

  it('throws when KANBEI_APP_INSTALLATION_ID is missing', () => {
    expect(() =>
      loadGithubAppConfig({
        KANBEI_APP_ID: '1',
        KANBEI_APP_PRIVATE_KEY: VALID_PEM,
      }),
    ).toThrow(/KANBEI_APP_INSTALLATION_ID/);
  });

  it('throws when neither private key source is provided', () => {
    expect(() =>
      loadGithubAppConfig({
        KANBEI_APP_ID: '1',
        KANBEI_APP_INSTALLATION_ID: '2',
      }),
    ).toThrow(/PRIVATE_KEY/);
  });

  it('throws when both inline and path private key sources are provided', () => {
    expect(() =>
      loadGithubAppConfig({
        KANBEI_APP_ID: '1',
        KANBEI_APP_INSTALLATION_ID: '2',
        KANBEI_APP_PRIVATE_KEY: VALID_PEM,
        KANBEI_APP_PRIVATE_KEY_PATH: '/some/path.pem',
      }),
    ).toThrow(/both/i);
  });

  it('throws when the inline PEM does not look like a PEM', () => {
    expect(() =>
      loadGithubAppConfig({
        KANBEI_APP_ID: '1',
        KANBEI_APP_INSTALLATION_ID: '2',
        KANBEI_APP_PRIVATE_KEY: 'not a pem',
      }),
    ).toThrow(/PEM/);
  });

  it('does not silently accept blank env values', () => {
    expect(() =>
      loadGithubAppConfig({
        KANBEI_APP_ID: '   ',
        KANBEI_APP_INSTALLATION_ID: '2',
        KANBEI_APP_PRIVATE_KEY: VALID_PEM,
      }),
    ).toThrow(/KANBEI_APP_ID/);
  });
});
