"use strict";

// Página de consentimento: aberta ao instalar; nada é pedido a serviços
// externos até o utilizador aceitar.

async function answer(remoteConsent) {
  const settings = await loadSettings();
  settings.remoteConsent = remoteConsent;
  settings.remoteConsentAnswered = true;
  await browser.storage.local.set({ settings });
  window.close();
}

document.getElementById("allow").addEventListener("click", () => answer(true));
document.getElementById("deny").addEventListener("click", () => answer(false));
