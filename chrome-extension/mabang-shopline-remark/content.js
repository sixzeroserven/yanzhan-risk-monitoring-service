(() => {
  const DEFAULT_API_URL = "https://yanzhan.eu.cc/api/order-remarks/shopline";
  const ORDER_ID_RE = /\b\d{16,40}\b/g;
  const MAX_IDS_PER_REQUEST = 300;
  const SHOPLINE_IDS_PER_HTTP = 100;
  const SHOPLAZZA_IDS_PER_HTTP = 10;
  const SCAN_DEBOUNCE_MS = 250;
  const EMPTY_RETRY_MS = 30000;
  const LOADING_RETRY_MS = 12000;
  const ANCHOR_TEXT_PRIORITY = ["申报", "待处理", "已发货", "已作废", "打印", "拆分", "备注", "RMA", "退款"];
  const noteCache = new Map();
  const missingCache = new Map();
  const apiOrderCache = new Map();
  const requestInFlight = new Set();
  const pendingLoadingIds = new Set();
  let scanTimer = null;
  let inFlight = false;

  function loadConfig() {
    return new Promise((resolve) => {
      try {
        if (!globalThis.chrome?.storage?.sync) {
          resolve({ apiUrl: DEFAULT_API_URL, token: "" });
          return;
        }
        chrome.storage.sync.get(
          {
            apiUrl: DEFAULT_API_URL,
            token: ""
          },
          resolve
        );
      } catch (error) {
        // Happens when the extension is reloaded while the old content script is still on the page.
        resolve({ apiUrl: DEFAULT_API_URL, token: "" });
      }
    });
  }

  function unique(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function uniqueBy(values, keyFn) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
      const key = keyFn(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }

  function cleanStoreHint(value) {
    return String(value || "")
      .trim()
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .slice(0, 120);
  }

  function collectSearchText(row) {
    const parts = [row.textContent || ""];
    const attrNames = ["data-order-id", "data-id", "data-platform-order-id", "title", "href"];
    const elements = [row, ...Array.from(row.querySelectorAll("[data-order-id],[data-id],[data-platform-order-id],[title],a[href]"))];
    for (const el of elements) {
      for (const name of attrNames) {
        const value = el.getAttribute && el.getAttribute(name);
        if (value) parts.push(value);
      }
    }
    return parts.join(" ");
  }

  function extractOrderIds(text) {
    if (!text) return [];
    ORDER_ID_RE.lastIndex = 0;
    return unique(text.match(ORDER_ID_RE) || []);
  }

  function extractStoreHint(text) {
    const domain = String(text || "").match(/\b[a-z0-9][a-z0-9-]*\.(?:myshopline|myshoplazza|myshoplaza)\.com\b/i);
    if (domain) return cleanStoreHint(domain[0].toLowerCase());

    const tokens = String(text || "")
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (let i = 0; i < tokens.length - 1; i += 1) {
      if (/^(shopline|shoplazza)$/i.test(tokens[i])) {
        return cleanStoreHint(tokens[i + 1]);
      }
    }
    return "";
  }

  function extractPlatformHint(text) {
    const normalized = String(text || "").toLowerCase();
    if (/\bshoplazza\b/.test(normalized)) return "shoplazza";
    if (/\bshopline\b/.test(normalized)) return "shopline";
    return "";
  }

  function hasOrderId(text) {
    ORDER_ID_RE.lastIndex = 0;
    return ORDER_ID_RE.test(text || "");
  }

  function orderContainers() {
    const fallbackSelectors = [
      ".order-item",
      ".order-list-item",
      ".orderData",
      "[data-order-id]",
      "[data-id]"
    ];
    const tableRows = Array.from(document.querySelectorAll("tr")).filter((el) => hasOrderId(collectSearchText(el)));
    return tableRows.length > 0 ? tableRows : Array.from(document.querySelectorAll(fallbackSelectors.join(",")));
  }

  function elementMarker(el) {
    const parts = [];
    let current = el;
    for (let depth = 0; current && depth < 8; depth += 1) {
      parts.push(current.className || "", current.id || "");
      current = current.parentElement;
    }
    return parts.join(" ").toLowerCase();
  }

  function isRightSideClone(el) {
    const marker = elementMarker(el);
    return /fixed[-_ ]?right|right[-_ ]?fixed|__fixed-right|fixedright/.test(marker);
  }

  function isLeftFixedClone(el) {
    const marker = elementMarker(el);
    return /fixed/.test(marker) && !isRightSideClone(el);
  }

  function sortPreferredRows(rows) {
    return rows.slice().sort((a, b) => {
      const leftScore = (isLeftFixedClone(b) ? 1 : 0) - (isLeftFixedClone(a) ? 1 : 0);
      if (leftScore) return leftScore;
      const rightScore = (isRightSideClone(a) ? 1 : 0) - (isRightSideClone(b) ? 1 : 0);
      if (rightScore) return rightScore;
      return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
    });
  }

  function candidateRows() {
    const candidates = sortPreferredRows(orderContainers());
    const seenIds = new Set();
    const out = [];
    for (const el of candidates) {
      if (el.dataset.shoplineRemarkScanned === "done") continue;
      if (el.dataset.shoplineRemarkScanned === "loading") {
        const scannedAt = Number(el.dataset.shoplineRemarkScannedAt || 0);
        if (Date.now() - scannedAt < LOADING_RETRY_MS) continue;
      }
      if (el.dataset.shoplineRemarkScanned === "empty") {
        const scannedAt = Number(el.dataset.shoplineRemarkScannedAt || 0);
        if (Date.now() - scannedAt < EMPTY_RETRY_MS) continue;
      }
      const text = collectSearchText(el);
      const ids = extractOrderIds(text);
      if (ids.length === 0) continue;
      if (ids.every((id) => seenIds.has(id))) continue;
      if (isRightSideClone(el) && ids.some((id) => seenIds.has(id))) continue;
      ids.forEach((id) => seenIds.add(id));
      out.push(el);
    }
    return out;
  }

  function findInjectionTarget(row, orderId) {
    if (row.tagName === "TR") {
      const cells = Array.from(row.querySelectorAll("td,th"));
      const orderCell = cells.find((cell) => (cell.textContent || "").includes(orderId));
      if (orderCell) return orderCell;
      return row.querySelector("td") || row;
    }
    return row;
  }

  function findOrderIdTextNode(target, orderId) {
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.includes(orderId)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.parentElement?.closest(".mb-sl-remark,.mb-sl-remark-loading,.mb-sl-remark-anchor")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    return walker.nextNode();
  }

  function isVisibleElement(el) {
    return Boolean(el?.getClientRects?.().length);
  }

  function findActionAnchorElement(row) {
    const candidates = Array.from(row.querySelectorAll("a,button,span,em,i,b,label,strong,td,div"))
      .filter((el) => isVisibleElement(el) && !el.closest(".mb-sl-remark,.mb-sl-remark-loading,.mb-sl-remark-anchor"));
    for (const label of ANCHOR_TEXT_PRIORITY) {
      const exact = candidates
        .filter((el) => (el.textContent || "").trim() === label)
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      if (exact.length > 0) return exact[0];
    }

    for (const label of ANCHOR_TEXT_PRIORITY) {
      const loose = candidates
        .filter((el) => {
          const text = (el.textContent || "").replace(/\s+/g, "");
          return text.includes(label) && text.length <= 12;
        })
        .sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
      if (loose.length > 0) return loose[0];
    }
    return null;
  }

  function getRemarkAnchor(target, orderId) {
    const existing = target.querySelector(`.mb-sl-remark-anchor[data-order-id="${orderId}"]`);
    if (existing) return existing;

    const anchor = document.createElement("span");
    anchor.className = "mb-sl-remark-anchor";
    anchor.dataset.orderId = orderId;

    const textNode = findOrderIdTextNode(target, orderId);
    if (textNode?.parentNode) {
      const insertAt = textNode.nodeValue.indexOf(orderId) + orderId.length;
      const afterNode = textNode.splitText(insertAt);
      textNode.parentNode.insertBefore(anchor, afterNode);
    } else {
      target.appendChild(anchor);
    }
    return anchor;
  }

  function getPlacementAnchor(row, orderId) {
    const existing = row.querySelector(`.mb-sl-remark-anchor[data-order-id="${orderId}"]`);
    if (existing) return existing;

    const actionEl = findActionAnchorElement(row);
    if (actionEl) {
      const anchor = document.createElement("span");
      anchor.className = "mb-sl-remark-anchor mb-sl-remark-anchor--action";
      anchor.dataset.orderId = orderId;
      // Put the label inside the short action/status element so it is visually on its right.
      actionEl.appendChild(anchor);
      return anchor;
    }

    return getRemarkAnchor(findInjectionTarget(row, orderId), orderId);
  }


  function noteTitle(note) {
    const text = String(note || "").trim();
    const hit = text.match(/(?:⚠️)?\s*【[^】]+】/);
    if (hit) {
      const title = hit[0].trim();
      return title.startsWith("⚠️") ? title : `⚠️${title}`;
    }
    if (text.includes("黑名单")) return "⚠️【黑名单拦截】";
    if (text.includes("争议")) return "⚠️【争议用户】";
    if (text.includes("风险评分")) return "⚠️【风险评分提醒】";
    if (text.includes("邮箱")) return "⚠️【邮箱异常】";
    return "⚠️风险备注";
  }

  function noteDetail(note) {
    const text = String(note || "").trim();
    const title = noteTitle(text);
    const withoutIconTitle = text.replace(/(?:⚠️)?\s*【[^】]+】/, "").trim();
    return withoutIconTitle || text || title;
  }

  function closeOpenPopups(except) {
    for (const item of document.querySelectorAll(".mb-sl-remark.is-open")) {
      if (except && item === except) continue;
      item.classList.remove("is-open");
    }
    const popup = document.querySelector(".mb-sl-remark-global-popup");
    if (popup && !except) popup.remove();
  }

  function showRemarkPopup(anchor, note) {
    const existing = document.querySelector(".mb-sl-remark-global-popup");
    if (existing && existing.dataset.orderId === anchor.dataset.orderId) {
      existing.remove();
      anchor.classList.remove("is-open");
      return;
    }
    if (existing) existing.remove();
    closeOpenPopups(anchor);
    anchor.classList.add("is-open");

    const popup = document.createElement("div");
    popup.className = "mb-sl-remark-global-popup";
    popup.dataset.orderId = anchor.dataset.orderId || "";
    popup.textContent = noteDetail(note);
    document.body.appendChild(popup);

    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = Math.min(420, Math.max(280, window.innerWidth - margin * 2));
    popup.style.width = `${width}px`;
    let left = rect.left;
    if (left + width > window.innerWidth - margin) left = window.innerWidth - width - margin;
    if (left < margin) left = margin;
    let top = rect.bottom + margin;
    if (top + popup.offsetHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - popup.offsetHeight - margin);
    }
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function renderNote(row, orderId, note) {
    if (!note || row.querySelector(`.mb-sl-remark[data-order-id="${orderId}"]`)) return;
    removeLoadingForOrderIds([orderId]);
    const wrap = document.createElement("span");
    wrap.className = "mb-sl-remark";
    wrap.dataset.orderId = orderId;
    wrap.dataset.note = note;

    const text = document.createElement("span");
    text.className = "mb-sl-remark-text";
    text.textContent = noteTitle(note);

    wrap.appendChild(text);
    wrap.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showRemarkPopup(wrap, note);
    });
    getPlacementAnchor(row, orderId).appendChild(wrap);
    row.dataset.shoplineRemarkScanned = "done";
    row.dataset.shoplineRemarkScannedAt = String(Date.now());
  }

  function resetRowsForOrderIds(orderIds) {
    const ids = new Set(orderIds);
    if (ids.size === 0) return;
    const rows = orderContainers();
    for (const row of rows) {
      const text = collectSearchText(row);
      if (![...ids].some((id) => text.includes(id))) continue;
      if (row.querySelector(".mb-sl-remark")) continue;
      delete row.dataset.shoplineRemarkScanned;
      delete row.dataset.shoplineRemarkScannedAt;
    }
  }

  function renderLoadingForOrderIds(orderIds) {
    for (const id of new Set(orderIds.filter(Boolean))) {
      if (!noteCache.has(id) && !document.querySelector(`.mb-sl-remark[data-order-id="${id}"]`)) {
        pendingLoadingIds.add(id);
      }
    }
    flushPendingLoadings();
  }

  function flushPendingLoadings() {
    const ids = Array.from(pendingLoadingIds);
    if (ids.length === 0) return;
    const rows = sortPreferredRows(orderContainers());
    for (const id of ids) {
      if (noteCache.has(id) || document.querySelector(`.mb-sl-remark[data-order-id="${id}"]`)) {
        pendingLoadingIds.delete(id);
        continue;
      }
      if (document.querySelector(`.mb-sl-remark-loading[data-order-id="${id}"]`)) {
        pendingLoadingIds.delete(id);
        continue;
      }
      const row = rows.find((item) => collectSearchText(item).includes(id));
      if (!row) continue;
      if (row.querySelector(".mb-sl-remark,.mb-sl-remark-loading")) {
        pendingLoadingIds.delete(id);
        continue;
      }
      const wrap = document.createElement("span");
      wrap.className = "mb-sl-remark-loading";
      wrap.dataset.orderId = id;
      const dot = document.createElement("span");
      dot.className = "mb-sl-remark-loading-dot";
      const text = document.createElement("span");
      text.textContent = "风险检测中";
      wrap.appendChild(dot);
      wrap.appendChild(text);
      getPlacementAnchor(row, id).appendChild(wrap);
      removeDuplicateLoadings(id, row);
      pendingLoadingIds.delete(id);
      row.dataset.shoplineRemarkScanned = "loading";
      row.dataset.shoplineRemarkScannedAt = String(Date.now());
    }
  }

  function removeLoadingForOrderIds(orderIds) {
    for (const id of new Set(orderIds.filter(Boolean))) {
      pendingLoadingIds.delete(id);
      for (const item of document.querySelectorAll(`.mb-sl-remark-loading[data-order-id="${id}"]`)) {
        const row = item.closest("tr,.order-item,.order-list-item,.orderData,[data-order-id],[data-id]");
        item.remove();
        if (row?.dataset.shoplineRemarkScanned === "loading") {
          delete row.dataset.shoplineRemarkScanned;
          delete row.dataset.shoplineRemarkScannedAt;
        }
      }
    }
  }

  function resolvedOrderIds(orderRequests) {
    return unique(orderRequests
      .filter((item) => noteCache.has(item.orderId) || isMissingCached(requestKey(item)))
      .map((item) => item.orderId));
  }

  function renderCachedNotesForOrderIds(orderIds) {
    const ids = Array.from(new Set(orderIds.filter((id) => noteCache.has(id))));
    if (ids.length === 0) return 0;
    let rendered = 0;
    const rows = sortPreferredRows(orderContainers());
    for (const id of ids) {
      const row = rows.find((item) => collectSearchText(item).includes(id));
      if (!row) continue;
      const before = row.querySelectorAll(".mb-sl-remark").length;
      renderNote(row, id, noteCache.get(id));
      const after = row.querySelectorAll(".mb-sl-remark").length;
      if (after > before) rendered += 1;
      removeDuplicateRemarks(id, row);
    }
    return rendered;
  }

  function removeDuplicateRemarks(orderId, keepRow) {
    for (const item of document.querySelectorAll(`.mb-sl-remark[data-order-id="${orderId}"]`)) {
      if (keepRow.contains(item)) continue;
      item.remove();
    }
  }

  function removeDuplicateLoadings(orderId, keepRow) {
    for (const item of document.querySelectorAll(`.mb-sl-remark-loading[data-order-id="${orderId}"]`)) {
      if (keepRow.contains(item)) continue;
      item.remove();
    }
  }

  function retryRenderCachedNotes(orderIds, attempts = 20) {
    const ids = Array.from(new Set(orderIds.filter((id) => noteCache.has(id))));
    if (ids.length === 0 || attempts <= 0) return;
    const rendered = renderCachedNotesForOrderIds(ids);
    const remaining = ids.filter((id) => !document.querySelector(`.mb-sl-remark[data-order-id="${id}"]`));
    if (remaining.length === 0 || rendered > 0 && attempts <= 3) return;
    window.setTimeout(() => retryRenderCachedNotes(remaining, attempts - 1), 500);
  }

  function markEmpty(row) {
    row.dataset.shoplineRemarkScanned = "empty";
    row.dataset.shoplineRemarkScannedAt = String(Date.now());
  }

  function requestKey(item) {
    return `${item.platform || "shopline"}|${item.orderId}|${item.storeDomain || item.storeName || ""}`;
  }

  function isMissingCached(key) {
    const cachedAt = missingCache.get(key);
    return cachedAt && Date.now() - cachedAt < EMPTY_RETRY_MS;
  }

  function markMissing(key) {
    missingCache.set(key, Date.now());
  }

  function pickInlineNote(item) {
    return String(item?.customer_note || item?.customerNote || item?.note || item?.orderRemarkText || "").trim();
  }

  function chunk(values, size) {
    const out = [];
    for (let i = 0; i < values.length; i += size) {
      out.push(values.slice(i, i + size));
    }
    return out;
  }

  function endpointForPlatform(apiUrl, platform) {
    const base = apiUrl || DEFAULT_API_URL;
    if (platform !== "shoplazza") return base;
    return base.includes("/shopline") ? base.replace(/\/shopline\b/, "/shoplazza") : base.replace(/\/$/, "") + "/shoplazza";
  }

  async function fetchNotes(orderRequests) {
    const uniqueRequests = uniqueBy(orderRequests, requestKey);
    for (const request of uniqueRequests) {
      if (request.platform !== "shoplazza") continue;
      const inlineNote = pickInlineNote(request);
      if (inlineNote) {
        noteCache.set(request.orderId, inlineNote);
        renderCachedNotesForOrderIds([request.orderId]);
      } else {
        markMissing(requestKey(request));
      }
    }

    const requestsToFetch = uniqueRequests
      .filter((item) => item.platform !== "shoplazza")
      .filter((item) => {
        const key = requestKey(item);
        return !noteCache.has(item.orderId) && !isMissingCached(key) && !requestInFlight.has(key);
      })
      .slice(0, MAX_IDS_PER_REQUEST);
    const requestedIds = new Set(requestsToFetch.map((item) => item.orderId));
    const requestedKeys = new Set(requestsToFetch.map(requestKey));
    if (requestsToFetch.length === 0) return { requestedIds, requestedKeys };
    for (const key of requestedKeys) requestInFlight.add(key);
    const config = await loadConfig();
    const headers = {
      "Content-Type": "application/json"
    };
    if (config.token) headers["X-Order-Remark-Token"] = config.token;

    const groups = new Map();
    for (const request of requestsToFetch) {
      const platform = request.platform || "shopline";
      if (!groups.has(platform)) groups.set(platform, []);
      groups.get(platform).push(request);
    }

    try {
      for (const [platform, requests] of groups.entries()) {
        const batchSize = platform === "shoplazza" ? SHOPLAZZA_IDS_PER_HTTP : SHOPLINE_IDS_PER_HTTP;
        for (const batch of chunk(requests, batchSize)) {
          try {
            const resp = await fetch(endpointForPlatform(config.apiUrl, platform), {
              method: "POST",
              headers,
              body: JSON.stringify({
                orders: batch,
                orderIds: batch.map((item) => item.orderId)
              })
            });
            if (!resp.ok) {
              for (const request of batch) markMissing(requestKey(request));
              console.warn(`[Mabang Shopline Remark] ${platform} remark lookup HTTP ${resp.status}`);
              continue;
            }
            const body = await resp.json();
            const data = body && body.data && typeof body.data === "object" ? body.data : {};
            for (const request of batch) {
              const id = request.orderId;
              const dataItem = data[id];
              const note = dataItem && (dataItem.customer_note || dataItem.customerNote);
              if (note) noteCache.set(id, String(note));
              else markMissing(requestKey(request));
            }
          } catch (error) {
            for (const request of batch) markMissing(requestKey(request));
            console.warn(`[Mabang Shopline Remark] ${platform} remark lookup failed:`, error);
          }
        }
      }
    } finally {
      for (const key of requestedKeys) requestInFlight.delete(key);
    }
    return { requestedIds, requestedKeys };
  }

  async function scan() {
    if (inFlight) return;
    inFlight = true;
    try {
      const rows = candidateRows();
      const rowItems = [];
      for (const row of rows) {
        const text = collectSearchText(row);
        const ids = extractOrderIds(text);
        if (ids.length === 0) {
          markEmpty(row);
          continue;
        }
        const storeHint = extractStoreHint(text);
        const platformHint = extractPlatformHint(text);
        rowItems.push({ row, ids, storeHint, platformHint });
      }

      const orders = rowItems
        .flatMap((item) =>
          item.ids.map((id) => ({
            platform: item.platformHint || apiOrderCache.get(id)?.platform || "shopline",
            orderId: id,
            storeName: item.storeHint || apiOrderCache.get(id)?.storeName || "",
            customer_note: apiOrderCache.get(id)?.customer_note || ""
          }))
        )
        .slice(0, MAX_IDS_PER_REQUEST);
      let fetchResult = { requestedIds: new Set(), requestedKeys: new Set() };
      if (orders.length > 0) {
        renderLoadingForOrderIds(orders.map((item) => item.orderId));
        fetchResult = await fetchNotes(orders);
        removeLoadingForOrderIds(resolvedOrderIds(orders));
      }

      let hasDeferredRows = false;
      for (const item of rowItems) {
        let rendered = false;
        for (const id of item.ids) {
          const note = noteCache.get(id);
          if (note) {
            renderNote(item.row, id, note);
            rendered = true;
            break;
          }
        }
        const allResolved = item.ids.every((id) => {
          const key = requestKey({
            platform: item.platformHint || apiOrderCache.get(id)?.platform || "shopline",
            orderId: id,
            storeName: item.storeHint || apiOrderCache.get(id)?.storeName || ""
          });
          return noteCache.has(id) || isMissingCached(key);
        });
        if (rendered || allResolved) {
          if (rendered) {
            item.row.dataset.shoplineRemarkScanned = "done";
            item.row.dataset.shoplineRemarkScannedAt = String(Date.now());
          }
          if (!rendered) markEmpty(item.row);
        } else {
          hasDeferredRows = true;
        }
      }
      if (hasDeferredRows) scheduleScan();
    } catch (error) {
      console.warn("[Mabang Shopline Remark] lookup failed:", error);
    } finally {
      inFlight = false;
    }
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, SCAN_DEBOUNCE_MS);
  }

  function isOwnRemarkNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    return Boolean(node.closest?.(".mb-sl-remark,.mb-sl-remark-loading,.mb-sl-remark-anchor"));
  }


  function bindPopupAutoClose() {
    window.addEventListener("scroll", () => closeOpenPopups(), true);
    window.addEventListener("resize", () => closeOpenPopups());
    document.addEventListener("wheel", () => closeOpenPopups(), true);
    document.addEventListener("touchmove", () => closeOpenPopups(), true);
  }

  function startObserver() {
    if (!document.documentElement) {
      window.setTimeout(startObserver, 50);
      return;
    }
    const observer = new MutationObserver((mutations) => {
      const onlyOwnChanges = mutations.every((mutation) => {
        if (isOwnRemarkNode(mutation.target)) return true;
        return Array.from(mutation.addedNodes || []).every(isOwnRemarkNode);
      });
      if (onlyOwnChanges) return;
      flushPendingLoadings();
      scheduleScan();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    scheduleScan();
  }

  document.addEventListener("click", (event) => {
    const target = event.target?.closest?.(".mb-sl-remark");
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      showRemarkPopup(target, target.dataset.note || "");
      return;
    }
    closeOpenPopups();
  }, true);
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "mabang-shopline-remark-hook" || data.type !== "mabang-orders") return;
    const orders = Array.isArray(data.orders) ? data.orders : [];
    const validOrders = orders
      .map((item) => ({
        platform: String(item?.platform || "").trim().toLowerCase(),
        orderId: String(item?.orderId || "").trim(),
        storeName: cleanStoreHint(item?.storeName || ""),
        customer_note: String(item?.customer_note || item?.customerNote || "").trim()
      }))
      .filter((item) => ["shopline", "shoplazza"].includes(item.platform) && /^\d{10,40}$/.test(item.orderId));
    if (validOrders.length === 0) return;
    for (const item of validOrders) {
      apiOrderCache.set(item.orderId, {
        platform: item.platform,
        storeName: item.storeName,
        customer_note: item.customer_note
      });
    }
    resetRowsForOrderIds(validOrders.map((item) => item.orderId));
    renderLoadingForOrderIds(validOrders.map((item) => item.orderId));
    fetchNotes(validOrders)
      .then(() => {
        removeLoadingForOrderIds(resolvedOrderIds(validOrders));
        retryRenderCachedNotes(validOrders.map((item) => item.orderId));
        scheduleScan();
      })
      .catch((error) => {
        removeLoadingForOrderIds(validOrders.map((item) => item.orderId));
        console.warn("[Mabang Shopline Remark] API-data lookup failed:", error);
        scheduleScan();
      });
  });
  bindPopupAutoClose();
  window.postMessage({ source: "mabang-shopline-remark-hook", type: "content-ready" }, window.location.origin);
  startObserver();
})();
