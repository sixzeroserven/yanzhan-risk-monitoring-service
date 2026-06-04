const DEFAULT_API_URL = "https://yanzhan.eu.cc/api/order-remarks/shopline";

function load() {
  chrome.storage.sync.get({ apiUrl: DEFAULT_API_URL, token: "" }, (items) => {
    document.getElementById("apiUrl").value = items.apiUrl || DEFAULT_API_URL;
    document.getElementById("token").value = items.token || "";
  });
}

function save() {
  const apiUrl = document.getElementById("apiUrl").value.trim() || DEFAULT_API_URL;
  const token = document.getElementById("token").value.trim();
  chrome.storage.sync.set({ apiUrl, token }, () => {
    const status = document.getElementById("status");
    status.textContent = "已保存";
    window.setTimeout(() => {
      status.textContent = "";
    }, 1600);
  });
}

document.getElementById("save").addEventListener("click", save);
load();
