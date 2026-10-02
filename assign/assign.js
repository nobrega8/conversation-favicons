"use strict";

const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get("token");

let customFavicons = {};
let domains = [];

async function init() {
  const context = await browser.runtime.sendMessage({
    type: "getAssignContext",
    token,
  });
  if (!context) {
    window.close();
    return;
  }
  $("kindHint").textContent =
    context.kind == "event"
      ? "Applies to every occurrence of this event."
      : "Replies to this conversation will be tagged automatically.";
  $("subject").textContent = context.subject;
  $("subject").title = context.subject;
  domains = [...context.current];

  // Sugestões: domínios já atribuídos e com favicon personalizado.
  customFavicons = await loadCustomFavicons();
  const tags = [...(await loadConversationTags()), ...(await loadEventTags())];
  const suggestions = new Set([
    ...tags.flatMap(t => t.domains),
    ...Object.keys(customFavicons),
  ]);
  for (const domain of [...suggestions].sort()) {
    const option = document.createElement("option");
    option.value = domain;
    $("suggestions").appendChild(option);
  }

  renderChips();
  updatePreview();
  $("domain").focus();
}

/** Igual à resolução do background: personalizado > cache. */
async function faviconFor(domain, depth = 0) {
  const custom = customFavicons[domain];
  if (custom?.type == "alias" && depth < 5) {
    return faviconFor(custom.value, depth + 1);
  }
  if (custom?.dataUrl) {
    return custom.dataUrl;
  }
  const key = `fav:${domain}`;
  return (await browser.storage.local.get(key))[key]?.url ?? null;
}

/** Pinta `el` com o favicon do domínio, ou a inicial se ainda não houver. */
async function paintIcon(el, domain) {
  const url = domain.includes(".") ? await faviconFor(domain) : null;
  el.textContent = "";
  el.style.backgroundImage = "";
  el.style.backgroundColor = "";
  if (url) {
    el.style.backgroundImage = `url("${url}")`;
  } else if (domain) {
    // O favicon real é descarregado depois de guardar.
    el.textContent = domain[0];
    el.style.backgroundColor = "#888";
  }
}

function renderChips() {
  const list = $("chips");
  list.replaceChildren();
  for (const domain of domains) {
    const li = document.createElement("li");
    const icon = document.createElement("span");
    icon.className = "icon";
    paintIcon(icon, domain);

    const name = document.createElement("span");
    name.textContent = domain;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "✕";
    remove.title = `Remove ${domain}`;
    remove.addEventListener("click", () => {
      domains = domains.filter(d => d != domain);
      renderChips();
      $("domain").focus();
    });

    li.append(icon, name, remove);
    list.appendChild(li);
  }
}

let previewRequest = 0;
async function updatePreview() {
  const request = ++previewRequest;
  const domain = normalizeDomain($("domain").value);
  const preview = $("preview");
  preview.classList.add("icon");
  preview.classList.toggle("filled", Boolean(domain));
  if (!domain) {
    await paintIcon(preview, "");
    return;
  }
  // Ignora respostas de pedidos antigos enquanto se escreve.
  const scratch = document.createElement("span");
  await paintIcon(scratch, domain);
  if (request == previewRequest) {
    preview.textContent = scratch.textContent;
    preview.style.backgroundImage = scratch.style.backgroundImage;
    preview.style.backgroundColor = scratch.style.backgroundColor;
  }
}

/** Acrescenta o que está escrito; devolve false se for inválido. */
function addTyped() {
  const input = $("domain");
  const typed = input.value.split(/[\s,;]+/).map(normalizeDomain).filter(Boolean);
  if (typed.some(d => !d.includes("."))) {
    input.setCustomValidity("Enter a valid domain, e.g. company.com");
    input.reportValidity();
    return false;
  }
  for (const domain of typed) {
    if (!domains.includes(domain)) {
      domains.push(domain);
    }
  }
  input.value = "";
  renderChips();
  updatePreview();
  return true;
}

async function save() {
  if (!addTyped()) {
    return;
  }
  await browser.runtime.sendMessage({ type: "assignDomains", token, domains });
  window.close();
}

$("domain").addEventListener("input", () => {
  $("domain").setCustomValidity("");
  updatePreview();
});
$("domain").addEventListener("keydown", event => {
  if (event.key == "Enter" && $("domain").value.trim()) {
    event.preventDefault();
    addTyped();
  }
});
$("add").addEventListener("click", () => {
  addTyped();
  $("domain").focus();
});
$("form").addEventListener("submit", event => {
  event.preventDefault();
  save();
});
$("cancel").addEventListener("click", () => window.close());
document.addEventListener("keydown", event => {
  if (event.key == "Escape") {
    window.close();
  }
});

init();
