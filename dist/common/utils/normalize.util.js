"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeString = safeString;
exports.normalizeEmail = normalizeEmail;
exports.normalizePhone = normalizePhone;
exports.normalizeAddress = normalizeAddress;
exports.joinAddressParts = joinAddressParts;
exports.joinBlacklistAddressParts = joinBlacklistAddressParts;
exports.getDeviceFingerprint = getDeviceFingerprint;
function safeString(value) {
    if (value === null || value === undefined)
        return "";
    return String(value).trim();
}
function normalizeEmail(value) {
    return safeString(value).toLowerCase();
}
function normalizePhone(value) {
    return safeString(value).replace(/[^\d+]/g, "");
}
function normalizeAddress(value) {
    return safeString(value).toLowerCase().replace(/\s+/g, " ");
}
function joinAddressParts(address = {}) {
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
function joinBlacklistAddressParts(address = {}) {
    const parts = [address.detail_address, address.address2].map(safeString).filter(Boolean);
    return normalizeAddress(parts.join(" "));
}
function getDeviceFingerprint(order = {}) {
    const attrs = Array.isArray(order.note_attributes)
        ? order.note_attributes
        : [];
    const hit = attrs.find((item) => ["device_fingerprint", "fingerprint", "deviceFingerprint"].includes(safeString(item.name)));
    if (hit === null || hit === void 0 ? void 0 : hit.value)
        return safeString(hit.value);
    return (safeString(order.device_fingerprint) ||
        safeString(order.client_fingerprint) ||
        safeString(order.browser_fingerprint));
}
//# sourceMappingURL=normalize.util.js.map