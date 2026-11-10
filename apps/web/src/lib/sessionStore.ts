/**
 * Where the browser keeps the signed-in session.
 *
 * Sessions live in `sessionStorage` (scoped to the tab, gone when it closes), never in `localStorage`, and the
 * Supabase client is pointed at the same store so its refresh token is not persisted across browser restarts either.
 * This shrinks how long a stolen browser profile or a leaked storage dump stays useful. It does NOT stop script
 * running in the page from reading the token: that is what the Content-Security-Policy (render.yaml) is for.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export const TOKEN_KEY = 'pocketful_jwt_token';
export const USER_KEY = 'pocketful_user';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

/** Decodes a JWT payload. JWTs are base64url (`-`/`_`, no padding), which `atob` alone rejects. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Unreadable or exp-less tokens count as expired: fail closed. `skewMs` expires them slightly early. */
export function isTokenExpired(token: string, now = Date.now(), skewMs = 0): boolean {
  const exp = decodeJwtPayload(token)?.['exp'];
  return typeof exp !== 'number' || now + skewMs >= exp * 1000;
}

/** Removes anything an older build left in the given (long-lived) storage, including Supabase's own session. */
export function purgeLegacyStorage(legacy: StorageLike | null): void {
  if (!legacy) return;
  const doomed: string[] = [];
  for (let i = 0; i < legacy.length; i++) {
    const k = legacy.key(i);
    if (k && (k === TOKEN_KEY || k === USER_KEY || /^sb-.*-auth-token/.test(k))) doomed.push(k);
  }
  for (const k of doomed) legacy.removeItem(k);
}

function memoryStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    }
  };
}

export function createSessionStore(primary: StorageLike | null, legacy: StorageLike | null) {
  // Some privacy modes make sessionStorage throw: fall back to memory so the app still works for this page load.
  const store: StorageLike = primary ?? memoryStorage();
  try {
    purgeLegacyStorage(legacy);
  } catch {
    /* storage can be blocked; nothing to purge then */
  }
  const clear = () => {
    store.removeItem(TOKEN_KEY);
    store.removeItem(USER_KEY);
  };
  return {
    storage: store,
    /** The live token, or null. An expired token is cleared as a side effect. */
    getToken(): string | null {
      const t = store.getItem(TOKEN_KEY);
      if (!t) return null;
      if (isTokenExpired(t)) {
        clear();
        return null;
      }
      return t;
    },
    getUser(): SessionUser | null {
      if (!this.getToken()) return null;
      const raw = store.getItem(USER_KEY);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SessionUser;
      } catch {
        return null;
      }
    },
    set(token: string, user: SessionUser): void {
      store.setItem(TOKEN_KEY, token);
      store.setItem(USER_KEY, JSON.stringify(user));
    },
    clear
  };
}

function safeStorage(kind: 'sessionStorage' | 'localStorage'): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window[kind];
  } catch {
    return null;
  }
}

export const sessionStore = createSessionStore(safeStorage('sessionStorage'), safeStorage('localStorage'));
