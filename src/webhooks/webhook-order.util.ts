import {
  getDeviceFingerprint,
  normalizeAddress,
  normalizeEmail,
  normalizePhone,
  safeString
} from "../common/utils/normalize.util";

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore parse errors and fall back to empty object.
    }
  }
  return {};
}

function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    const text = safeString(value);
    if (text) return text;
  }
  return "";
}

export function extractOrderPayload(body: Record<string, unknown>): Record<string, unknown> {
  const nestedOrder = asObject(body.order);
  if (Object.keys(nestedOrder).length > 0) return nestedOrder;

  const data = asObject(body.data);
  const dataOrder = asObject(data.order);
  if (Object.keys(dataOrder).length > 0) return dataOrder;

  return body;
}

export function extractRiskIdentity(order: Record<string, unknown>) {
  const shipping = asObject(order.shipping_address);
  const billing = asObject(order.billing_address);
  const customer = asObject(order.customer);

  const email = normalizeEmail(
    pickFirstString(
      order.email,
      order.contact_email,
      customer.email,
      customer.contact_email,
      shipping.email,
      billing.email
    )
  );
  const phone = normalizePhone(
    pickFirstString(
      order.phone,
      order.phone_number,
      order.mobile,
      shipping.phone,
      shipping.mobile,
      billing.phone,
      billing.mobile,
      customer.phone,
      customer.mobile
    )
  );
  const address2 = normalizeAddress(pickFirstString(shipping.address2, billing.address2));
  const fingerprint = safeString(getDeviceFingerprint(order));

  return { email, phone, address2, fingerprint };
}

