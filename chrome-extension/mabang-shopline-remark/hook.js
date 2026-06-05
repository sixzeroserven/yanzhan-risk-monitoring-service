(() => {
  const SOURCE = "mabang-shopline-remark-hook";
  const ORDER_API_RE = /mod=order\.oTc/i;

  function decodeHtmlEntities(value) {
    const el = document.createElement("textarea");
    el.innerHTML = String(value || "");
    return el.value;
  }

  function stripHtml(value) {
    const text = String(value || "");
    if (!text.includes("<")) return decodeHtmlEntities(text).trim();
    const el = document.createElement("div");
    el.innerHTML = text;
    return decodeHtmlEntities(el.textContent || el.innerText || "").trim();
  }

  function findOrderDataList(value, depth = 0) {
    if (!value || depth > 4) return null;
    if (Array.isArray(value)) return null;
    if (typeof value !== "object") return null;
    if (Array.isArray(value.orderDataList)) return value.orderDataList;
    if (Array.isArray(value.order_data_list)) return value.order_data_list;
    for (const key of ["data", "result", "rows", "list"]) {
      const hit = findOrderDataList(value[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function parseBody(text) {
    if (!text || typeof text !== "string") return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function pickOrders(body) {
    const rows = findOrderDataList(body);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return null;
        const platform = stripHtml(row.platformIdText || "").toLowerCase();
        if (!["shopline", "shoplazza"].includes(platform)) return null;
        const orderId = String(row.platformOrderId || "").trim();
        const storeName = stripHtml(row.shopIdText || "");
        const customerNote = platform === "shoplazza" ? stripHtml(row.orderRemarkText || "") : "";
        if (!/^\d{10,40}$/.test(orderId)) return null;
        return { platform, orderId, storeName, customer_note: customerNote };
      })
      .filter(Boolean);
  }

  const recentOrderBatches = [];

  function postOrders(orders) {
    window.postMessage({ source: SOURCE, type: "mabang-orders", orders }, window.location.origin);
  }

  function publishFromText(url, text) {
    if (!ORDER_API_RE.test(String(url || ""))) return;
    const body = parseBody(text);
    if (!body) return;
    const orders = pickOrders(body);
    if (orders.length === 0) return;
    recentOrderBatches.push(orders);
    if (recentOrderBatches.length > 5) recentOrderBatches.shift();
    postOrders(orders);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== SOURCE || data.type !== "content-ready") return;
    for (const orders of recentOrderBatches) postOrders(orders);
  });

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (ORDER_API_RE.test(String(url || ""))) {
          response.clone().text().then((text) => publishFromText(url, text)).catch(() => undefined);
        }
      } catch {
        // Never let the observer affect Mabang's own request flow.
      }
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__mbSlRemarkUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    try {
      this.addEventListener("loadend", () => {
        try {
          const url = this.__mbSlRemarkUrl || this.responseURL || "";
          if (!ORDER_API_RE.test(String(url))) return;
          if (typeof this.responseText !== "string") return;
          publishFromText(url, this.responseText);
        } catch {
          // Ignore observer errors.
        }
      });
    } catch {
      // Ignore observer errors.
    }
    return originalSend.apply(this, args);
  };
})();
