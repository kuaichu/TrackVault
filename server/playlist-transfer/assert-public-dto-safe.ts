import assert from "node:assert/strict";

const forbiddenKeys = new Set([
  "raw",
  "ownerkey",
  "clientsessionid",
  "sid",
  "credentialfingerprint",
  "credentialdigest",
  "cookie",
  "token",
  "key",
  "cancelrequested",
  "generation",
  "guard"
]);

export function assertPublicDtoSafe(value: unknown, secretSentinel: string) {
  const visited = new WeakSet<object>();

  function visit(current: unknown, path: string) {
    if (typeof current === "string") {
      assert.equal(current.includes(secretSentinel), false, `secret sentinel found at ${path}`);
      return;
    }
    if (typeof current !== "object" || current === null) {
      return;
    }
    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }

    for (const [key, nested] of Object.entries(current)) {
      assert.equal(forbiddenKeys.has(key.toLocaleLowerCase()), false, `forbidden key ${key} found at ${path}`);
      visit(nested, `${path}.${key}`);
    }
  }

  visit(value, "$root");
}
