/** `PATCH /me`'s limit, so a provider's name is one the user could have typed. */
const MAX_NAME_LENGTH = 80;

/**
 * A name Google or Apple gave for the person, as `users.name` can hold it:
 * trimmed and cut to 80 characters, never through a surrogate pair. `null`
 * for anything that isn't a non-blank string.
 */
export function providerName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  let name = raw.trim();
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH);
    if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
    name = name.trimEnd();
  }

  return name === '' ? null : name;
}
