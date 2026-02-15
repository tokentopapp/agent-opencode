import { describe, expect, test } from 'bun:test';
import * as os from 'os';
import {
  OPENCODE_AUTH_PATH,
  OPENCODE_CONFIG_PATH,
  OPENCODE_DB_PATH,
  OPENCODE_MESSAGES_PATH,
  OPENCODE_PARTS_PATH,
  OPENCODE_SESSIONS_PATH,
  OPENCODE_STORAGE_PATH,
} from '../src/paths.ts';

const home = os.homedir();

describe('path constants', () => {
  test('OPENCODE_AUTH_PATH is under ~/.local/share/opencode/', () => {
    expect(OPENCODE_AUTH_PATH).toBe(`${home}/.local/share/opencode/auth.json`);
  });

  test('OPENCODE_CONFIG_PATH is under ~/.config/opencode/', () => {
    expect(OPENCODE_CONFIG_PATH).toBe(`${home}/.config/opencode/opencode.json`);
  });

  test('OPENCODE_DB_PATH is under ~/.local/share/opencode/', () => {
    expect(OPENCODE_DB_PATH).toBe(`${home}/.local/share/opencode/opencode.db`);
  });

  test('OPENCODE_STORAGE_PATH is under ~/.local/share/opencode/storage', () => {
    expect(OPENCODE_STORAGE_PATH).toBe(`${home}/.local/share/opencode/storage`);
  });

  test('OPENCODE_SESSIONS_PATH is storage/session', () => {
    expect(OPENCODE_SESSIONS_PATH).toBe(`${home}/.local/share/opencode/storage/session`);
  });

  test('OPENCODE_MESSAGES_PATH is storage/message', () => {
    expect(OPENCODE_MESSAGES_PATH).toBe(`${home}/.local/share/opencode/storage/message`);
  });

  test('OPENCODE_PARTS_PATH is storage/part', () => {
    expect(OPENCODE_PARTS_PATH).toBe(`${home}/.local/share/opencode/storage/part`);
  });

  test('storage sub-paths are children of OPENCODE_STORAGE_PATH', () => {
    expect(OPENCODE_SESSIONS_PATH.startsWith(OPENCODE_STORAGE_PATH)).toBe(true);
    expect(OPENCODE_MESSAGES_PATH.startsWith(OPENCODE_STORAGE_PATH)).toBe(true);
    expect(OPENCODE_PARTS_PATH.startsWith(OPENCODE_STORAGE_PATH)).toBe(true);
  });
});
