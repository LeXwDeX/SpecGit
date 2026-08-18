export type Evidence<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; fix?: string };

export const ok = <T>(value: T): Evidence<T> => ({ ok: true, value });

export const fail = <T>(code: string, message: string, fix?: string): Evidence<T> => ({
  ok: false,
  code,
  message,
  fix,
});
