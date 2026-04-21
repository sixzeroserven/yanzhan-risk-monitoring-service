export function safeString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}
export function normalizeEmail(value: unknown): string {
  return safeString(value).toLowerCase();
}
export function normalizePhone(value: unknown): string {
  return safeString(value).replace(/[^\d+]/g, "");
}
export function normalizeAddress(value: unknown): string {
  return safeString(value).toLowerCase().replace(/\s+/g, " ");
}
export function joinAddressParts(address: Record<string, unknown> = {}): string {
  const parts = [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.country,
    address.zip
  ]
    .map(safeString)
    .filter(Boolean);
  return normalizeAddress(parts.join(" "));
}

/** Only detail line + address2 — used for blacklist matching (excludes city/country/zip/address1). */
export function joinBlacklistAddressParts(address: Record<string, unknown> = {}): string {
  const parts = [address.detail_address, address.address2].map(safeString).filter(Boolean);
  return normalizeAddress(parts.join(" "));
}
export function getDeviceFingerprint(order: Record<string, unknown> = {}): string {
  const attrs = Array.isArray(order.note_attributes)
    ? (order.note_attributes as Array<{ name?: string; value?: string }>)
    : [];
  const hit = attrs.find((item) =>
    ["device_fingerprint", "fingerprint", "deviceFingerprint"].includes(safeString(item.name))
  );
  if (hit?.value) return safeString(hit.value);
  return (
    safeString(order.device_fingerprint) ||
    safeString(order.client_fingerprint) ||
    safeString(order.browser_fingerprint)
  );
}
