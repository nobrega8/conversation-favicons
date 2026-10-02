"use strict";

const ICON_SIZE = 64; // as imagens personalizadas são guardadas a 64x64

const $ = id => document.getElementById(id);

// ---- Definições simples (guardadas a cada alteração) ----

async function initSettings() {
  const settings = await loadSettings();
  for (const el of document.querySelectorAll("[data-setting]")) {
    const key = el.dataset.setting;
    if (el.type == "checkbox") {
      el.checked = settings[key];
    } else if (key == "ignoredDomains") {
      el.value = settings[key].join("\n");
    } else {
      el.value = settings[key];
    }
    el.addEventListener("change", saveSettings);
  }
}

async function saveSettings() {
  const settings = await loadSettings();
  for (const el of document.querySelectorAll("[data-setting]")) {
    const key = el.dataset.setting;
    if (el.type == "checkbox") {
      settings[key] = el.checked;
      if (key == "remoteConsent") {
        settings.remoteConsentAnswered = true;
      }
    } else if (key == "ignoredDomains") {
      settings[key] = [
        ...new Set(el.value.split(/[\s,;]+/).map(normalizeDomain).filter(Boolean)),
      ];
      el.value = settings[key].join("\n");
    } else if (key == "maxIcons") {
      settings[key] = Math.min(10, Math.max(1, parseInt(el.value) || 3));
      el.value = settings[key];
    }
  }
  await browser.storage.local.set({ settings });
  toast("Saved");
}

// ---- Favicons personalizados ----

async function renderCustomList() {
  const customs = await loadCustomFavicons();
  const list = $("customList");
  list.replaceChildren();
  const domains = Object.keys(customs).sort();
  $("customEmpty").hidden = domains.length > 0;

  for (const domain of domains) {
    const custom = customs[domain];
    const li = document.createElement("li");

    const preview = document.createElement("img");
    preview.className = "preview";
    preview.alt = "";
    const url = await previewFor(domain, customs);
    if (url) {
      preview.src = url;
    } else {
      preview.classList.add("missing");
    }

    const name = document.createElement("span");
    name.className = "domain";
    name.textContent = domain;
    name.title = domain;

    const source = document.createElement("span");
    source.className = "source";
    source.textContent =
      custom.type == "alias"
        ? `Same as ${custom.value}`
        : custom.type == "url"
          ? custom.value
          : `File: ${custom.value}`;
    source.title = source.textContent;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      const current = await loadCustomFavicons();
      delete current[domain];
      await browser.storage.local.set({ customFavicons: current });
      renderCustomList();
      toast("Removed");
    });

    li.append(preview, name, source, remove);
    list.appendChild(li);
  }
}

/** Para um alias, mostra o favicon do domínio de destino, se já for conhecido. */
async function previewFor(domain, customs, depth = 0) {
  const custom = customs[domain];
  if (custom?.type == "alias" && depth < 5) {
    return previewFor(custom.value, customs, depth + 1);
  }
  if (custom?.dataUrl) {
    return custom.dataUrl;
  }
  const key = `fav:${domain}`;
  return (await browser.storage.local.get(key))[key]?.url ?? null;
}

function updateFormFields() {
  const type = $("customType").value;
  $("customFile").hidden = type != "file";
  $("customUrl").hidden = type != "url";
  $("customAlias").hidden = type != "alias";
}

async function addCustom(event) {
  event.preventDefault();
  showError(null);

  const domain = normalizeDomain($("customDomain").value);
  const type = $("customType").value;
  if (!domain.includes(".")) {
    showError("Enter a valid domain, e.g. company.com");
    return;
  }

  try {
    let custom;
    if (type == "alias") {
      const target = normalizeDomain($("customAlias").value);
      if (!target.includes(".") || target == domain) {
        throw new Error("Enter a different, valid domain to copy the icon from.");
      }
      custom = { type, value: target };
    } else if (type == "url") {
      const url = $("customUrl").value.trim();
      let origin;
      try {
        origin = new URL(url).origin;
      } catch (e) {
        throw new Error("Enter a valid image URL.");
      }
      // Tem de ser o primeiro passo assíncrono (requer o gesto do utilizador).
      const granted = await browser.permissions.request({
        origins: [`${origin}/*`],
      });
      if (!granted) {
        throw new Error(`Permission to access ${origin} was denied.`);
      }
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) {
        throw new Error(`Could not download the image (HTTP ${response.status}).`);
      }
      custom = { type, value: url, dataUrl: await toIcon(await response.blob()) };
    } else {
      const file = $("customFile").files[0];
      if (!file) {
        throw new Error("Choose an image file.");
      }
      custom = { type, value: file.name, dataUrl: await toIcon(file) };
    }

    const customs = await loadCustomFavicons();
    customs[domain] = custom;
    await browser.storage.local.set({ customFavicons: customs });
    $("customForm").reset();
    updateFormFields();
    renderCustomList();
    toast(`Favicon set for ${domain}`);
  } catch (e) {
    showError(e.message);
  }
}

/** Reduz qualquer imagem a um PNG quadrado de ICON_SIZE px. */
function toIcon(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = ICON_SIZE;
      const w = img.naturalWidth || ICON_SIZE;
      const h = img.naturalHeight || ICON_SIZE;
      const scale = Math.min(ICON_SIZE / w, ICON_SIZE / h);
      const dw = w * scale;
      const dh = h * scale;
      canvas
        .getContext("2d")
        .drawImage(img, (ICON_SIZE - dw) / 2, (ICON_SIZE - dh) / 2, dw, dh);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file is not an image Thunderbird can read."));
    };
    img.src = url;
  });
}

// ---- Conversas marcadas ----

const TAG_LISTS = {
  conversationTags: {
    load: loadConversationTags,
    list: "tagList",
    empty: "tagEmpty",
    label: tag => tag.subject || "(no subject)",
  },
  eventTags: {
    load: loadEventTags,
    list: "eventTagList",
    empty: "eventTagEmpty",
    label: tag => tag.title || "(untitled event)",
  },
};

async function renderTagList(storageKey) {
  const { load, list: listId, empty, label } = TAG_LISTS[storageKey];
  const tags = (await load()).sort((a, b) => b.created - a.created);
  const customs = await loadCustomFavicons();
  const list = $(listId);
  list.replaceChildren();
  $(empty).hidden = tags.length > 0;

  for (const tag of tags) {
    const li = document.createElement("li");

    const previews = document.createElement("span");
    previews.className = "previews";
    for (const domain of tag.domains) {
      const preview = document.createElement("img");
      preview.className = "preview";
      preview.alt = "";
      preview.title = domain;
      const url = await previewFor(domain, customs);
      if (url) {
        preview.src = url;
      } else {
        preview.classList.add("missing");
      }
      previews.appendChild(preview);
    }

    const name = document.createElement("span");
    name.className = "domain";
    name.textContent = tag.domains.join(", ");
    name.title = name.textContent;

    const subject = document.createElement("span");
    subject.className = "source";
    subject.textContent = label(tag);
    const created = new Date(tag.created).toLocaleString();
    subject.title = `${subject.textContent}\nTagged ${created}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      const current = await load();
      await browser.storage.local.set({
        [storageKey]: current.filter(t => t.id != tag.id),
      });
      toast("Removed");
    });

    li.append(previews, name, subject, remove);
    list.appendChild(li);
  }
}

// ---- Cache ----

async function clearCache() {
  await browser.runtime.sendMessage({ type: "clearCache" });
  renderCustomList();
  toast("Cache cleared");
}

// ---- UI ----

function showError(message) {
  $("customError").hidden = !message;
  $("customError").textContent = message ?? "";
}

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 1500);
}

$("customType").addEventListener("change", updateFormFields);
$("customForm").addEventListener("submit", addCustom);
$("clearCache").addEventListener("click", clearCache);

// Mantém as listas em dia (ex.: conversa marcada com a página aberta).
browser.storage.onChanged.addListener((changes, area) => {
  if (area != "local") {
    return;
  }
  for (const key of Object.keys(TAG_LISTS)) {
    if (changes[key] || changes.customFavicons) {
      renderTagList(key);
    }
  }
});

initSettings();
renderCustomList();
renderTagList("conversationTags");
renderTagList("eventTags");
