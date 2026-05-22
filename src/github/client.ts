// GitHub App authenticated Octokit factory.
// See docs/01-architecture.md §7 (auth flow) and .env.example for the
// expected environment variables.

import { readFileSync } from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export interface AppEnv {
  KANBEI_APP_ID?: string;
  KANBEI_APP_INSTALLATION_ID?: string;
  KANBEI_APP_PRIVATE_KEY?: string;
  KANBEI_APP_PRIVATE_KEY_PATH?: string;
}

export interface GithubAppConfig {
  appId: number;
  installationId: number;
  privateKey: string;
}

type ReadFile = (path: string) => string;

const defaultReadFile: ReadFile = (path) => readFileSync(path, 'utf8');

function requirePositiveInt(env: AppEnv, key: keyof AppEnv): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    throw new Error(`Missing required env var ${key}.`);
  }
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`${key} must be a positive integer, got "${raw}".`);
  }
  const n = Number.parseInt(raw, 10);
  if (n <= 0) {
    throw new Error(`${key} must be a positive integer, got "${raw}".`);
  }
  return n;
}

function looksLikePem(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text);
}

export function loadGithubAppConfig(env: AppEnv, readFile: ReadFile = defaultReadFile): GithubAppConfig {
  const appId = requirePositiveInt(env, 'KANBEI_APP_ID');
  const installationId = requirePositiveInt(env, 'KANBEI_APP_INSTALLATION_ID');

  const inline = env.KANBEI_APP_PRIVATE_KEY?.trim();
  const path = env.KANBEI_APP_PRIVATE_KEY_PATH?.trim();

  if (inline && path) {
    throw new Error(
      'Both KANBEI_APP_PRIVATE_KEY and KANBEI_APP_PRIVATE_KEY_PATH are set; choose one.',
    );
  }
  if (!inline && !path) {
    throw new Error(
      'One of KANBEI_APP_PRIVATE_KEY or KANBEI_APP_PRIVATE_KEY_PATH must be set.',
    );
  }

  const privateKey = inline ? env.KANBEI_APP_PRIVATE_KEY! : readFile(path!);
  if (!looksLikePem(privateKey)) {
    throw new Error(
      'GitHub App private key does not look like a PEM (missing "-----BEGIN ... PRIVATE KEY-----" header).',
    );
  }

  return { appId, installationId, privateKey };
}

export function createGithubAppClient(config: GithubAppConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey: config.privateKey,
      installationId: config.installationId,
    },
  });
}
