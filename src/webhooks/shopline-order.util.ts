import { normalizeEmail, normalizePhone, safeString } from "../common/utils/normalize.util";

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function pickFirstString(...values: unknown[]): string {
  for (const value of values) {
    const text = safeString(value);
    if (text) return text;
  }
  return "";
}

function dig(root: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function pickAddress(order: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const direct = asObject(order[key]);
    if (Object.keys(direct).length > 0) return direct;
  }
  return {};
}

export function normalizeShoplineOrderForRisk(
  order: Record<string, unknown>,
  storeDomain: string,
  orderIdPrefix = ""
): Record<string, unknown> {
  const customer = asObject(order.customer);
  const shipping = pickAddress(order, "shipping_address", "shippingAddress", "shipping_addr", "delivery_address");
  const billing = pickAddress(order, "billing_address", "billingAddress");
  const rawOrderId = pickFirstString(order.id, order.order_id, order.orderId, order.admin_graphql_api_id);
  const displayName = pickFirstString(order.name, order.order_number, order.orderNo, order.order_no, order.number);
  const orderId = rawOrderId || displayName;
  const orderNumber = applyPrefix(displayName || orderId, orderIdPrefix);
  const email = normalizeEmail(
    pickFirstString(
      order.email,
      order.contact_email,
      order.customer_email,
      order.buyer_email,
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
      customer.phone,
      customer.mobile,
      shipping.phone,
      shipping.phone_number,
      shipping.mobile,
      billing.phone,
      billing.phone_number,
      billing.mobile
    )
  );

  return {
    ...order,
    id: orderId,
    order_id: orderId,
    order_number: orderNumber,
    name: orderNumber,
    platform_order_id: orderId,
    platform_order_number: orderNumber,
    platform: "shopline",
    shop_domain: storeDomain,
    store_domain: storeDomain,
    email,
    contact_email: email,
    phone,
    customer: {
      ...customer,
      email: email || normalizeEmail(customer.email),
      phone: phone || normalizePhone(customer.phone)
    },
    shipping_address: normalizeAddressObject(shipping),
    billing_address: normalizeAddressObject(billing),
    client_ip: pickFirstString(order.client_ip, order.clientIp, dig(order, "client_details", "browser_ip")),
    order_created_time: pickFirstString(
      order.order_at,
      order.created_at,
      order.create_at,
      order.placed_at,
      order.createdAt,
      order.orderCreatedAt
    )
  };
}

function normalizeAddressObject(address: Record<string, unknown>): Record<string, unknown> {
  const name = pickFirstString(address.name, address.contact_person, address.contactPerson, address.full_name);
  const phone = normalizePhone(pickFirstString(address.phone, address.phone_number, address.mobile, address.tel));
  return {
    ...address,
    name,
    phone,
    phone_number: phone,
    mobile: phone,
    country: pickFirstString(address.country, address.country_code, address.countryCode),
    province: pickFirstString(address.province, address.province_code, address.provinceCode, address.state),
    city: pickFirstString(address.city),
    district: pickFirstString(address.district),
    address1: pickFirstString(address.address1, address.address, address.detail_address, address.detailAddress),
    detail_address: pickFirstString(address.detail_address, address.detailAddress, address.address1, address.address),
    address2: pickFirstString(address.address2, address.address_2, address.apartment)
  };
}

function applyPrefix(value: string, prefix: string): string {
  if (!value || !prefix || value.startsWith(prefix)) return value;
  return `${prefix}${value}`;
}
