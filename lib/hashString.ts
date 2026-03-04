/**
 * Content-dependent string hash for use when expo-crypto is unavailable (e.g. module load failure).
 * Returns a 16-char hex string so it can be used where SHA256.substring(0,16) is expected (e.g. photos.image_hash).
 * Deterministic: same input same output.
 */
function djb2(str: string, seed: number): number {
 let h = seed;
 for (let i = 0; i < str.length; i++) {
 h = ((h << 5) + h + str.charCodeAt(i)) | 0;
 }
 return h >>> 0;
}

export function hashStringToHex16(input: string): string {
 const a = djb2(input, 5381);
 const b = djb2(input + '\u0001', 33);
 const hex = (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).slice(0, 16);
 return hex;
}

/**
 * SHA256 of `data` as 16-char hex, using expo-crypto when available.
 * No top-level import of expo-crypto only dynamic import() inside try/catch.
 * If the module fails to load (e.g. "Requiring unknown module") or exports are broken
 * (e.g. CryptoDigestAlgorithm.SHA256 undefined), falls back to hashStringToHex16 so the app never crashes.
 */
export async function sha256Hex16(data: string): Promise<string> {
 try {
 const Crypto = await import('expo-crypto');
 const algo = Crypto?.CryptoDigestAlgorithm?.SHA256;
 const digest = typeof Crypto?.digestStringAsync === 'function' ? Crypto.digestStringAsync : null;
 if (!algo || !digest) {
 return hashStringToHex16(data);
 }
 const full = await digest.call(Crypto, algo, data);
 return (full ?? '').substring(0, 16);
 } catch {
 return hashStringToHex16(data);
 }
}
