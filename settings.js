"use strict";

/* Definições partilhadas pelo background e pela página de opções. */

const DEFAULT_SETTINGS = {
  showInList: true,
  showInHeader: true,
  maxIcons: 3,
  includeRecipients: true,
  excludeOwnDomains: true,
  ignoredDomains: [],
  showInCalendar: true,
  showInAddressBook: true,
  remoteConsent: false,
  remoteConsentAnswered: false,
};

async function loadSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

/** domínio -> { type: "file" | "url" | "alias", value, dataUrl? } */
async function loadCustomFavicons() {
  const { customFavicons } = await browser.storage.local.get("customFavicons");
  return customFavicons ?? {};
}

/** Aceita "joao@empresa.pt", "https://www.empresa.pt/x", etc. */
function normalizeDomain(input) {
  let domain = String(input ?? "").trim().toLowerCase();
  domain = domain.slice(domain.lastIndexOf("@") + 1);
  domain = domain.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0];
  return domain.replace(/^www\./, "").replace(/\.$/, "");
}

/** Uma entrada por conversa: [{ id, domains, subject, keys: [Message-IDs], created }] */
async function loadConversationTags() {
  const { conversationTags } = await browser.storage.local.get(
    "conversationTags"
  );
  // A 0.4.0 guardava um só `domain` por conversa.
  return (conversationTags ?? []).map(({ domain, ...tag }) => ({
    ...tag,
    domains: tag.domains ?? (domain ? [domain] : []),
  }));
}

/** Uma entrada por evento: [{ id: UID, domains, title, created }] */
async function loadEventTags() {
  const { eventTags } = await browser.storage.local.get("eventTags");
  return eventTags ?? [];
}
