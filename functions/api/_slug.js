const CHARS = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o/l/1 confusion

export function generateSlug(length = 6) {
  let slug = "";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (const byte of array) {
    slug += CHARS[byte % CHARS.length];
  }
  return slug;
}
