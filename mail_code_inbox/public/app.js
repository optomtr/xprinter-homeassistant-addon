const $ = (id) => document.getElementById(id);
const state = { domain: "", addresses: [], selectedAddressId: null, selectedMessageId: null, loading: false };

async function request(path, options = {}) {
  const response = await fetch(new URL(path.replace(/^\//u, ""), document.baseURI), {
    credentials: "same-origin",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Не удалось выполнить запрос");
  return result;
}

function notice(message) {
  const target = $("notice");
  target.textContent = message;
  target.hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { target.hidden = true; }, 4000);
}

function formatTime(value) {
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(value);
}

function addressText(address) {
  return `${address.localPart}@${state.domain}`;
}

function renderAddresses() {
  const list = $("addressList");
  list.replaceChildren();
  const all = document.createElement("button");
  all.type = "button";
  all.className = `address-item all-addresses ${state.selectedAddressId === null ? "active" : ""}`;
  all.innerHTML = '<span class="address-symbol">▤</span><span class="address-name">Все входящие</span>';
  all.addEventListener("click", () => selectAddress(null));
  list.append(all);
  for (const address of state.addresses) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `address-item ${state.selectedAddressId === address.id ? "active" : ""} ${address.enabled ? "" : "disabled"}`;
    const symbol = document.createElement("span");
    symbol.className = "address-symbol";
    symbol.textContent = address.localPart.slice(0, 1).toUpperCase();
    const content = document.createElement("span");
    content.className = "address-name";
    const name = document.createElement("strong");
    name.textContent = address.localPart;
    const label = document.createElement("small");
    label.textContent = address.label || state.domain;
    content.append(name, label);
    item.append(symbol, content);
    item.addEventListener("click", () => selectAddress(address.id));
    list.append(item);
  }
  $("addressCount").textContent = String(state.addresses.length);
}

function renderHeading() {
  const address = state.addresses.find((item) => item.id === state.selectedAddressId);
  $("mailboxOverline").textContent = address ? (address.enabled ? "АКТИВНЫЙ АДРЕС" : "ПРИЁМ ОСТАНОВЛЕН") : "ВСЕ АДРЕСА";
  $("mailboxTitle").textContent = address ? addressText(address) : "Входящие письма";
  $("mailboxSubtitle").textContent = address?.label || (address ? "Письма и коды для этого адреса." : "Коды из писем появятся здесь сразу после доставки.");
  $("copyAddressButton").hidden = !address;
  $("toggleAddressButton").hidden = !address;
  $("toggleAddressButton").textContent = address?.enabled ? "Остановить приём" : "Включить приём";
}

function renderMessages(messages) {
  const list = $("messageList");
  list.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = '<div class="empty-icon">✉</div><h2>Пока писем нет</h2><p>Отправьте тестовое письмо на созданный адрес. Входящие появятся здесь автоматически.</p>';
    list.append(empty);
    return;
  }
  for (const message of messages) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "message-card";
    const avatar = document.createElement("span");
    avatar.className = "sender-avatar";
    avatar.textContent = message.sender.slice(0, 1).toUpperCase();
    const summary = document.createElement("span");
    summary.className = "message-summary";
    const sender = document.createElement("strong");
    sender.textContent = message.sender;
    const subject = document.createElement("span");
    subject.textContent = message.subject;
    const recipient = document.createElement("small");
    recipient.textContent = message.recipient;
    summary.append(sender, subject, recipient);
    const side = document.createElement("span");
    side.className = "message-side";
    const time = document.createElement("time");
    time.textContent = formatTime(message.receivedAt);
    side.append(time);
    if (message.code) {
      const code = document.createElement("strong");
      code.className = "code-pill";
      code.textContent = message.code;
      side.append(code);
    }
    card.append(avatar, summary, side);
    card.addEventListener("click", () => openMessage(message.id));
    list.append(card);
  }
}

async function loadAddresses() {
  const result = await request("/api/addresses");
  state.domain = result.domain;
  state.addresses = result.addresses;
  $("domainLabel").textContent = result.domain;
  $("addressSuffix").textContent = `@${result.domain}`;
  renderAddresses();
  renderHeading();
}

async function loadMessages(silent = false) {
  if (state.loading) return;
  state.loading = true;
  try {
    const query = state.selectedAddressId === null ? "" : `?addressId=${state.selectedAddressId}`;
    const result = await request(`/api/messages${query}`);
    renderMessages(result.messages);
    $("refreshStatus").textContent = `Обновлено ${new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(Date.now())}`;
  } catch (error) {
    if (!silent) notice(error.message);
  } finally { state.loading = false; }
}

async function selectAddress(id) {
  state.selectedAddressId = id;
  renderAddresses();
  renderHeading();
  await loadMessages();
}

async function openMessage(id) {
  try {
    const { message } = await request(`/api/messages/${id}`);
    state.selectedMessageId = id;
    $("detailSubject").textContent = message.subject;
    $("detailMeta").textContent = `От: ${message.sender} · Кому: ${message.recipient} · ${formatTime(message.receivedAt)}`;
    $("detailBody").textContent = message.body || "Письмо не содержит текстовой части.";
    $("detailCode").hidden = !message.code;
    $("detailCodeValue").textContent = message.code || "";
    $("messageDialog").showModal();
  } catch (error) { notice(error.message); }
}

async function copy(value) {
  try { await navigator.clipboard.writeText(value); notice("Скопировано"); }
  catch { notice("Не удалось скопировать. Выделите текст вручную."); }
}

async function initialize() {
  const session = await request("/api/session");
  $("logoutButton").hidden = !!session.ingress;
  if (!session.authenticated) {
    $("loginView").hidden = false;
    $("appView").hidden = true;
    return;
  }
  $("loginView").hidden = true;
  $("appView").hidden = false;
  await loadAddresses();
  await loadMessages();
}

$("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("loginError").textContent = "";
  try {
    await request("/api/login", { method: "POST", body: { password: $("password").value } });
    $("password").value = "";
    await initialize();
  } catch (error) { $("loginError").textContent = error.message; }
});
$("logoutButton").addEventListener("click", async () => { await request("/api/logout", { method: "POST" }); await initialize(); });
$("newAddressButton").addEventListener("click", () => { $("createError").textContent = ""; $("newAddressDialog").showModal(); $("localPart").focus(); });
$("closeDialogButton").addEventListener("click", () => $("newAddressDialog").close());
$("cancelDialogButton").addEventListener("click", () => $("newAddressDialog").close());
$("closeMessageButton").addEventListener("click", () => $("messageDialog").close());
$("newAddressForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("createError").textContent = "";
  try {
    const result = await request("/api/addresses", { method: "POST", body: { localPart: $("localPart").value, label: $("addressLabel").value } });
    $("newAddressDialog").close();
    $("newAddressForm").reset();
    await loadAddresses();
    const created = state.addresses.find((address) => addressText(address) === result.address);
    if (created) await selectAddress(created.id);
    notice(`Создан адрес ${result.address}`);
  } catch (error) { $("createError").textContent = error.message; }
});
$("copyAddressButton").addEventListener("click", () => { const address = state.addresses.find((item) => item.id === state.selectedAddressId); if (address) copy(addressText(address)); });
$("copyCodeButton").addEventListener("click", () => copy($("detailCodeValue").textContent));
$("toggleAddressButton").addEventListener("click", async () => {
  const address = state.addresses.find((item) => item.id === state.selectedAddressId);
  if (!address) return;
  try {
    await request(`/api/addresses/${address.id}`, { method: "PATCH", body: { enabled: !address.enabled } });
    await loadAddresses();
    notice(address.enabled ? "Приём остановлен" : "Приём включён");
  } catch (error) { notice(error.message); }
});
$("deleteMessageButton").addEventListener("click", async () => {
  if (!state.selectedMessageId || !window.confirm("Удалить это письмо?")) return;
  try {
    await request(`/api/messages/${state.selectedMessageId}`, { method: "DELETE" });
    $("messageDialog").close();
    state.selectedMessageId = null;
    await loadMessages();
  } catch (error) { notice(error.message); }
});
$("refreshButton").addEventListener("click", () => loadMessages());
setInterval(() => { if (!document.hidden && !$("appView").hidden) loadMessages(true); }, 5000);
initialize().catch((error) => { $("loginView").hidden = false; $("loginError").textContent = error.message; });
