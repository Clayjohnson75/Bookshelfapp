/**
 * Sanitize before saving: all string fields going to Supabase (books, scan_jobs.books JSONB, etc.)
 * should be run through sanitizeTextForDb / sanitizeBookForDb so invalid escapes and NUL/surrogates
 * don't cause "unsupported Unicode escape sequence" or insert failures.
 *
 * Save path rule: build a plain JS object and pass to .insert()/.upsert()/.update(). Do not
 * JSON.stringify then JSON.parse or pass a string into a JSONB column let the client encode.
 */

/**
 * Log string content in an encoded way to confirm NUL/surrogate issues when save fails.
 * JSON.stringify shows escape sequences (e.g. \u0000 or dangling surrogates).
 */
export function debugString(s: string): { len: number; json: string } {
 return {
 len: s.length,
 json: JSON.stringify(s).slice(0, 4000),
 };
}

const HEX = new Set('0123456789abcdefABCDEF');

/**
 * Fix invalid backslash and \u sequences so the string is safe for JSON/JSONB.
 * - Valid JSON escapes: \\ \" \/ \b \f \n \r \t \uXXXX (exactly 4 hex digits).
 * - Lone backslash \\; invalid \u (not 4 hex) \\u + rest (so stored as literal).
 * Returns { value, changed } so caller can log when a fix was applied.
 */
function fixInvalidEscapes(s: string): { value: string; changed: boolean } {
 let out = '';
 let changed = false;
 for (let i = 0; i < s.length; i++) {
 const c = s[i];
 if (c !== '\\') {
 out += c;
 continue;
 }
 const next = s[i + 1];
 if (next === undefined) {
 out += '\\\\';
 changed = true;
 continue;
 }
 // Valid 2-char escapes
 if (next === '\\' || next === '"' || next === '/' || next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') {
 out += c + next;
 i++;
 continue;
 }
 if (next === 'u') {
 const hex4 = s.slice(i + 2, i + 6);
 const allHex = hex4.length === 4 && [...hex4].every((h) => HEX.has(h));
 if (allHex) {
 out += '\\u' + hex4;
 i += 5;
 continue;
 }
 // Invalid \u: rewrite to \\u (literal backslash + u) and keep following chars
 out += '\\\\u';
 changed = true;
 i += 1;
 continue;
 }
 // Lone backslash before other char escape the backslash
 out += '\\\\' + next;
 changed = true;
 i++;
 }
 return { value: out, changed };
}

export type SanitizeLogContext = { recordId?: string; field: string };

/**
 * Sanitize user-facing strings before Supabase insert/update.
 * - Removes NUL chars (Postgres rejects) and unpaired UTF-16 surrogates.
 * - Fixes invalid backslash and \u sequences (safe for JSON/JSONB).
 * When context is provided and a fix is applied, logs which record/field caused it.
 */
export function sanitizeTextForDb(
 input: unknown,
 context?: SanitizeLogContext
): string | null {
 if (input == null) return null;
 let s = String(input);

 // 1) Remove NUL chars (Postgres rejects them)
 const afterNul = s.replace(/\u0000/g, '');
 if (afterNul.length !== s.length) {
 if (context) {
 console.warn('[SANITIZE] NUL removed', { ...context, sample: s.slice(0, 80) });
 }
 s = afterNul;
 }

 // 2) Remove unpaired UTF-16 surrogates (broken emoji halves, etc.)
 let out = '';
 for (let i = 0; i < s.length; i++) {
 const c = s.charCodeAt(i);
 if (c >= 0xd800 && c <= 0xdbff) {
 const next = s.charCodeAt(i + 1);
 if (next >= 0xdc00 && next <= 0xdfff) {
 out += s[i] + s[i + 1];
 i++;
 }
 continue;
 }
 if (c >= 0xdc00 && c <= 0xdfff) continue;
 out += s[i];
 }
 s = out;

 // 3) Fix invalid backslash and \u sequences
 const { value: escaped, changed } = fixInvalidEscapes(s);
 if (changed && context) {
 console.warn('[SANITIZE] invalid escape fixed', { ...context, sample: s.slice(0, 80) });
 }
 s = escaped;

 s = s.trim();
 return s.length ? s : null;
}

/** Sanitize string fields on a book-like object before storing in DB (books table or scan_jobs.books JSONB). Handles both camelCase and snake_case. Logs which record/field caused a fix when sanitizer changes content. */
export function sanitizeBookForDb<T extends object>(book: T): T {
 const out = { ...book } as T;
 const recordId = (out as any).id ?? (out as any).book_key ?? (out as any).title ?? 'unknown';
 const strKeys = ['title', 'author', 'subtitle', 'description', 'publisher', 'publishedDate', 'published_date', 'language', 'printType', 'print_type', 'confidence'];
 for (const key of strKeys) {
 if (!(key in out)) continue;
 const val = (out as any)[key];
 if (typeof val !== 'string' && val != null) continue;
 const v = sanitizeTextForDb(val, { recordId: String(recordId).slice(0, 120), field: key });
 (out as any)[key] = v ?? (key === 'title' || key === 'author' ? '' : undefined);
 }
 return out;
}
