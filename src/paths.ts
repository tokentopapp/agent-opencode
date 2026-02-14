import * as os from 'os';
import * as path from 'path';

export const OPENCODE_AUTH_PATH = path.join(os.homedir(), '.local/share/opencode/auth.json');
export const OPENCODE_CONFIG_PATH = path.join(os.homedir(), '.config/opencode/opencode.json');
export const OPENCODE_STORAGE_PATH = path.join(os.homedir(), '.local/share/opencode/storage');
export const OPENCODE_SESSIONS_PATH = path.join(OPENCODE_STORAGE_PATH, 'session');
export const OPENCODE_MESSAGES_PATH = path.join(OPENCODE_STORAGE_PATH, 'message');
export const OPENCODE_PARTS_PATH = path.join(OPENCODE_STORAGE_PATH, 'part');
export const OPENCODE_DB_PATH = path.join(os.homedir(), '.local/share/opencode/opencode.db');
