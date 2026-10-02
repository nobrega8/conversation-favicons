"use strict";

const SUCCESS_TTL = 30 * 24 * 3600 * 1000; // 30 dias
const FAILURE_TTL = 7 * 24 * 3600 * 1000; // 7 dias
const MAX_PARALLEL = 4;
const MAX_ALIAS_DEPTH = 5;

const SOURCES = [
  domain =>
    `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`,
  domain => `https://icons.duckduckgo.com/ip3/${encodeURIComponent(domain)}.ico`,
];

let customFavicons = {};
let settings = { ...DEFAULT_SETTINGS };

// ---- Entrega ao experiment, agrupada para não redesenhar a cada favicon ----

let outbox = {};
let flushTimer = null;

function deliver(domain, url) {
  outbox[domain] = url;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      const batch = outbox;
      outbox = {};
      flushTimer = null;
      browser.faviconRows.setFavicons(batch).catch(console.error);
    }, 50);
  }
}

browser.faviconRows.onDomainsNeeded.addListener(domains => {
  for (const domain of domains) {
    resolve(domain)
      .then(url => deliver(domain, url))
      .catch(e => console.error("Favicon falhou:", domain, e));
  }
});

/** Personalizado > cache > download. */
async function resolve(domain, depth = 0) {
  const custom = customFavicons[domain];
  if (custom?.type == "alias" && depth < MAX_ALIAS_DEPTH) {
    return resolve(custom.value, depth + 1);
  }
  if (custom?.dataUrl) {
    return custom.dataUrl;
  }
  // Sem consentimento não se contacta nenhum serviço externo.
  if (!settings.remoteConsent) {
    return null;
  }

  const key = `fav:${domain}`;
  const entry = (await browser.storage.local.get(key))[key];
  const ttl = entry?.url ? SUCCESS_TTL : FAILURE_TTL;
  if (entry && Date.now() - entry.time < ttl) {
    return entry.url;
  }
  return download(domain);
}

// ---- Downloads, com limite de pedidos em paralelo ----

const inFlight = new Map();
const queue = [];
let running = 0;

function download(domain) {
  if (!inFlight.has(domain)) {
    inFlight.set(
      domain,
      new Promise(done => {
        queue.push({ domain, done });
        pump();
      })
    );
  }
  return inFlight.get(domain);
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const { domain, done } = queue.shift();
    running++;
    fetchFavicon(domain)
      .then(async url => {
        await browser.storage.local.set({
          [`fav:${domain}`]: { url, time: Date.now() },
        });
        done(url);
      })
      .catch(e => {
        console.error("Favicon falhou:", domain, e);
        done(null);
      })
      .finally(() => {
        inFlight.delete(domain);
        running--;
        pump();
      });
  }
}

async function fetchFavicon(domain) {
  for (const source of SOURCES) {
    try {
      const response = await fetch(source(domain), { credentials: "omit" });
      if (!response.ok) {
        continue;
      }
      const blob = await response.blob();
      if (!blob.size || !blob.type.startsWith("image/")) {
        continue;
      }
      return await blobToDataURL(blob);
    } catch (e) {
      // Tenta a fonte seguinte.
    }
  }
  return null;
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ---- Definições ----

browser.storage.onChanged.addListener((changes, area) => {
  if (area != "local") {
    return;
  }
  if (changes.settings) {
    loadSettings().then(async s => {
      const consentChanged = s.remoteConsent != settings.remoteConsent;
      settings = s;
      await browser.faviconRows.setSettings(s);
      if (consentChanged) {
        await browser.faviconRows.clearFavicons();
      }
    });
  }
  if (changes.customFavicons) {
    customFavicons = changes.customFavicons.newValue ?? {};
    browser.faviconRows.clearFavicons();
  }
  if (changes.conversationTags) {
    loadConversationTags().then(pushConversationTags);
  }
  if (changes.eventTags) {
    loadEventTags().then(pushEventTags);
  }
});

browser.runtime.onMessage.addListener(async message => {
  if (message?.type == "getAssignContext") {
    return pendingAssignments.get(message.token) ?? null;
  }
  if (message?.type == "assignDomains") {
    const pending = pendingAssignments.get(message.token);
    if (pending) {
      pendingAssignments.delete(message.token);
      if (pending.kind == "event") {
        await assignEventDomains(pending, message.domains);
      } else {
        await assignDomains(pending, message.domains);
      }
    }
    return true;
  }
  if (message?.type == "clearCache") {
    const all = await browser.storage.local.get(null);
    await browser.storage.local.remove(
      Object.keys(all).filter(k => k.startsWith("fav:"))
    );
    await browser.faviconRows.clearFavicons();
    return true;
  }
  return undefined;
});

// ---- Domínios atribuídos a uma conversa (menu de contexto) ----

const MENU_ASSIGN = "cf-assign-domain";
const MENU_REMOVE = "cf-remove-domain";
// token -> { keys, subject, current } enquanto a janela de atribuição está aberta
const pendingAssignments = new Map();

browser.menus.create({
  id: MENU_ASSIGN,
  title: "Assign company domains…",
  contexts: ["message_list"],
});
browser.menus.create({
  id: MENU_REMOVE,
  title: "Remove assigned domains",
  contexts: ["message_list"],
  visible: false,
});

/** Message-IDs e References das mensagens selecionadas. */
async function selectedConversationKeys(info) {
  const ids = (info.selectedMessages?.messages ?? []).map(m => m.id);
  return ids.length ? browser.faviconRows.getConversationKeys(ids) : [];
}

function tagsMatching(tags, keys) {
  const set = new Set(keys);
  return tags.filter(tag => tag.keys.some(k => set.has(k)));
}

function domainsOf(tags) {
  return [...new Set(tags.flatMap(t => t.domains))];
}

browser.menus.onShown.addListener(async info => {
  if (!info.contexts.includes("message_list")) {
    return;
  }
  const keys = await selectedConversationKeys(info);
  const domains = domainsOf(tagsMatching(await loadConversationTags(), keys));
  await browser.menus.update(MENU_REMOVE, {
    visible: domains.length > 0,
    title: domains.length
      ? `Remove assigned domains (${domains.join(", ")})`
      : "Remove assigned domains",
  });
  browser.menus.refresh();
});

browser.menus.onClicked.addListener(async info => {
  if (info.menuItemId != MENU_ASSIGN && info.menuItemId != MENU_REMOVE) {
    return;
  }
  const keys = await selectedConversationKeys(info);
  if (!keys.length) {
    return;
  }
  const tags = await loadConversationTags();
  const matching = tagsMatching(tags, keys);

  if (info.menuItemId == MENU_REMOVE) {
    await browser.storage.local.set({
      conversationTags: tags.filter(t => !matching.includes(t)),
    });
    return;
  }

  openAssignWindow({
    kind: "conversation",
    keys,
    subject: info.selectedMessages.messages[0]?.subject ?? "",
    current: domainsOf(matching),
  });
});

async function openAssignWindow(pending) {
  const token = crypto.randomUUID();
  pendingAssignments.set(token, pending);
  await browser.windows.create({
    url: `assign/assign.html?token=${token}`,
    type: "popup",
    width: 460,
    height: 320,
  });
}

/** Define a lista completa de domínios da conversa (vazia = remove). */
async function assignDomains({ keys, subject }, domains) {
  domains = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  // As entradas que já reconheciam esta conversa fundem-se numa só.
  const all = await loadConversationTags();
  const merged = tagsMatching(all, keys);
  const others = all.filter(t => !merged.includes(t));
  if (domains.length) {
    others.push({
      id: merged[0]?.id ?? crypto.randomUUID(),
      domains,
      subject: merged[0]?.subject || subject,
      keys: [...new Set([...merged.flatMap(t => t.keys), ...keys])],
      created: merged[0]?.created ?? Date.now(),
    });
  }
  await browser.storage.local.set({ conversationTags: others });
}

function pushConversationTags(tags) {
  const map = {};
  for (const tag of tags) {
    for (const key of tag.keys) {
      map[key] = [...new Set([...(map[key] ?? []), ...tag.domains])];
    }
  }
  browser.faviconRows.setConversationDomains(map).catch(console.error);
}

// ---- Domínios atribuídos a eventos do calendário ----

browser.faviconRows.onAssignEventRequested.addListener(async (ids, title) => {
  const tags = await loadEventTags();
  openAssignWindow({
    kind: "event",
    ids,
    subject: title,
    current: [
      ...new Set(tags.filter(t => ids.includes(t.id)).flatMap(t => t.domains)),
    ],
  });
});

/** Define a lista completa de domínios de cada evento (vazia = remove). */
async function assignEventDomains({ ids, subject }, domains) {
  domains = [...new Set(domains.map(normalizeDomain).filter(Boolean))];
  const all = await loadEventTags();
  const previous = new Map(all.map(t => [t.id, t]));
  const others = all.filter(t => !ids.includes(t.id));
  if (domains.length) {
    for (const id of ids) {
      others.push({
        id,
        domains,
        title: previous.get(id)?.title || subject,
        created: previous.get(id)?.created ?? Date.now(),
      });
    }
  }
  await browser.storage.local.set({ eventTags: others });
}

function pushEventTags(tags) {
  const map = Object.fromEntries(tags.map(t => [t.id, t.domains]));
  browser.faviconRows.setEventDomains(map).catch(console.error);
}

// ---- Consentimento (primeira execução) ----

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason != "install" && reason != "update") {
    return;
  }
  const current = await loadSettings();
  if (!current.remoteConsentAnswered) {
    browser.tabs.create({ url: "consent/consent.html" });
  }
});

// ---- Arranque ----

browser.tabs.onCreated.addListener(tab => {
  browser.faviconRows.patchTab(tab.id).catch(console.error);
});

async function init() {
  customFavicons = await loadCustomFavicons();
  settings = await loadSettings();
  await browser.faviconRows.setSettings(settings);
  pushConversationTags(await loadConversationTags());
  pushEventTags(await loadEventTags());
  for (const tab of await browser.tabs.query({})) {
    browser.faviconRows.patchTab(tab.id).catch(console.error);
  }
}

init();
