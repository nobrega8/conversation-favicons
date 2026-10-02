/* Experiment API: injeta favicons de domínio nos cartões do painel de
 * mensagens (about:3pane) e em cada pessoa do cabeçalho da mensagem
 * (about:message). Corre com privilégios de chrome. */

"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const CONTAINER_CLASS = "cf-favicons";
const RECIPIENT_CLASS = "cf-recipient-favicon";
const CONVERSATION_CLASS = "cf-conversation-favicon";
const EVENT_CLASS = "cf-event-favicons";
const MENU_CLASS = "cf-event-menu";
const CONTACT_CLASS = "cf-contact-favicons";
const STYLE_ID = "cf-favicons-style";

// Valores usados até o background enviar as definições guardadas.
const DEFAULT_SETTINGS = {
  showInList: true,
  showInHeader: true,
  maxIcons: 3,
  includeRecipients: true,
  excludeOwnDomains: true,
  ignoredDomains: [],
  showInCalendar: true,
  showInAddressBook: true,
};

const ICON_CSS = `
  .cf-icon {
    width: 16px;
    height: 16px;
    border-radius: 3px;
    flex: none;
  }
  .cf-letter {
    display: inline-grid;
    place-items: center;
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    color: white;
    text-transform: uppercase;
  }
`;

const LIST_CSS = `
  ${ICON_CSS}
  /* O nome encolhe ao tamanho do texto; os ícones ficam colados à direita
     dele e ocupam o espaço livre, empurrando a data para a ponta. */
  .sender:has(+ .${CONTAINER_CLASS}) {
    flex: 0 1 auto !important;
  }
  .${CONTAINER_CLASS} {
    display: inline-flex;
    flex: 1 0 auto;
    align-items: center;
    gap: 2px;
  }
  .${CONTAINER_CLASS} > .cf-more {
    font-size: 0.75rem;
    opacity: 0.7;
  }
`;

const MESSAGE_CSS = `
  ${ICON_CSS}
  img.${RECIPIENT_CLASS} {
    display: inline-block;
  }
`;

this.faviconRows = class extends ExtensionCommon.ExtensionAPI {
  constructor(extension) {
    super(extension);
    // domínio -> data URL | null (sem favicon). Ausente = ainda desconhecido.
    this.favicons = new Map();
    this.requested = new Set();
    this.pending = new Set();
    this.notifyTimer = null;
    this.listeners = new Set();
    this.assignListeners = new Set();
    this.calendarWindows = new Set();
    this.addressBookWindows = new Set();
    // UID do evento -> domínios atribuídos.
    this.eventDomains = new Map();
    this.listWindows = new Set();
    this.messageWindows = new Set();
    this.browserListeners = [];
    // "folderURI|threadId|numChildren" -> lista de domínios
    this.domainCache = new Map();
    this.ownDomains = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.ignoredDomains = new Set();
    // Message-ID (ou referência) -> domínios atribuídos à conversa.
    this.conversationDomains = new Map();

    // Mensagens abertas numa janela própria. O id inclui o do add-on para
    // não colidir com outra cópia instalada (ex.: versão com outro id).
    this.windowListenerId = `${extension.id}-message-window`;
    this.windowListenerRegistered = ExtensionSupport.registerWindowListener(
      this.windowListenerId,
      {
        chromeURLs: ["chrome://messenger/content/messageWindow.xhtml"],
        onLoadWindow: win => {
          this.watchBrowser(
            win.document.getElementById("messageBrowser"),
            "about:message",
            w => this.patchMessageWindow(w)
          );
        },
      }
    );

    // Qualquer about:message criado depois, onde quer que seja (ex.: a
    // mensagem aberta na vista de conversa, que tem um browser próprio).
    this.conversationViews = new Set();
    this.documentObserver = doc => {
      if (doc.documentURI?.startsWith("about:addressbook")) {
        this.patchAddressBookWindow(doc.defaultView);
      }
      if (doc.documentURI?.startsWith("about:message")) {
        const win = doc.defaultView;
        win?.addEventListener("load", () => this.patchMessageWindow(win), {
          once: true,
        });
      }
    };
    Services.obs.addObserver(this.documentObserver, "document-element-inserted");

    // Calendário: painel Eventos e vistas vivem na janela principal.
    this.mainWindowListenerId = `${extension.id}-main-window`;
    this.mainWindowListenerRegistered = ExtensionSupport.registerWindowListener(
      this.mainWindowListenerId,
      {
        chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
        onLoadWindow: win => this.patchCalendarWindow(win),
      }
    );
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    if (this.windowListenerRegistered) {
      ExtensionSupport.unregisterWindowListener(this.windowListenerId);
    }
    if (this.mainWindowListenerRegistered) {
      ExtensionSupport.unregisterWindowListener(this.mainWindowListenerId);
    }
    for (const win of this.calendarWindows) {
      try {
        this.unpatchCalendarWindow(win);
      } catch (e) {
        console.error(e);
      }
    }
    this.calendarWindows.clear();
    for (const win of this.addressBookWindows) {
      try {
        this.unpatchAddressBookWindow(win);
      } catch (e) {
        console.error(e);
      }
    }
    this.addressBookWindows.clear();
    Services.obs.removeObserver(
      this.documentObserver,
      "document-element-inserted"
    );
    clearTimeout(this.notifyTimer);
    for (const view of this.conversationViews) {
      view.__cfObserver?.disconnect();
      delete view.__cfObserver;
      for (const el of view.shadowRoot?.querySelectorAll(
        `.${CONVERSATION_CLASS}`
      ) ?? []) {
        el.remove();
      }
    }
    this.conversationViews.clear();
    for (const [browser, handler] of this.browserListeners) {
      browser.removeEventListener("load", handler, true);
    }
    for (const win of this.listWindows) {
      try {
        this.unpatchListWindow(win);
      } catch (e) {
        console.error(e);
      }
    }
    for (const win of this.messageWindows) {
      try {
        this.unpatchMessageWindow(win);
      } catch (e) {
        console.error(e);
      }
    }
    this.listWindows.clear();
    this.messageWindows.clear();
  }

  getAPI(context) {
    return {
      faviconRows: {
        patchTab: async tabId => {
          const nativeTab = context.extension.tabManager.get(tabId)?.nativeTab;
          const mode = nativeTab?.mode?.name;
          if (mode == "mail3PaneTab") {
            this.watchBrowser(nativeTab.chromeBrowser, "about:3pane", w =>
              this.patchListWindow(w)
            );
          } else if (mode == "mailMessageTab") {
            this.watchBrowser(nativeTab.chromeBrowser, "about:message", w =>
              this.patchMessageWindow(w)
            );
          } else if (mode == "addressBookTab") {
            this.watchBrowser(nativeTab.browser, "about:addressbook", w =>
              this.patchAddressBookWindow(w)
            );
          }
        },

        setSettings: async settings => {
          this.settings = { ...DEFAULT_SETTINGS, ...settings };
          this.ignoredDomains = new Set(this.settings.ignoredDomains);
          this.ownDomains = null;
          this.domainCache.clear();
          this.refreshAll();
        },

        setConversationDomains: async map => {
          this.conversationDomains = new Map(Object.entries(map));
          this.domainCache.clear();
          this.refreshAll();
        },

        getConversationKeys: async messageIds => {
          const keys = new Set();
          for (const id of messageIds) {
            const hdr = context.extension.messageManager.get(id);
            if (hdr) {
              for (const key of conversationKeys(hdr)) {
                keys.add(key);
              }
            }
          }
          return [...keys];
        },

        setEventDomains: async map => {
          this.eventDomains = new Map(Object.entries(map));
          this.refreshAll();
        },

        onAssignEventRequested: new ExtensionCommon.EventManager({
          context,
          name: "faviconRows.onAssignEventRequested",
          register: fire => {
            this.assignListeners.add(fire);
            return () => this.assignListeners.delete(fire);
          },
        }).api(),

        clearFavicons: async () => {
          this.favicons.clear();
          this.requested.clear();
          this.pending.clear();
          this.refreshAll();
        },

        setFavicons: async favicons => {
          for (const [domain, url] of Object.entries(favicons)) {
            this.favicons.set(domain, url);
          }
          this.refreshAll();
        },

        onDomainsNeeded: new ExtensionCommon.EventManager({
          context,
          name: "faviconRows.onDomainsNeeded",
          register: fire => {
            this.listeners.add(fire);
            // Pedidos feitos antes de o background estar a ouvir.
            if (this.requested.size) {
              fire.async([...this.requested]);
            }
            return () => this.listeners.delete(fire);
          },
        }).api(),
      },
    };
  }

  /**
   * Chama `patch` com a janela do browser assim que este tiver `url`
   * carregado, agora ou em carregamentos futuros.
   */
  watchBrowser(browser, url, patch) {
    if (!browser) {
      return;
    }
    const tryPatch = () => {
      const win = browser.contentWindow;
      if (
        win?.location.href.startsWith(url) &&
        win.document.readyState == "complete"
      ) {
        patch(win);
      }
    };
    tryPatch();
    browser.addEventListener("load", tryPatch, true);
    this.browserListeners.push([browser, tryPatch]);
  }

  /**
   * Envolve `proto[method]` para chamar `render(elemento)` depois do original.
   * O wrapper delega no renderer atual guardado no protótipo, por isso uma
   * nova instância do add-on (ao recarregar) toma conta do patch em vez de o
   * duplicar, e a instância antiga, ao desligar-se, já não o desfaz.
   */
  patchMethod(proto, method, render) {
    const key = `__cf_${method}`;
    if (!proto[key]) {
      const original = proto[method];
      const state = { original, render: null, owner: null, wrapper: null };
      proto[key] = state;
      state.wrapper = function (...args) {
        const result = state.original.apply(this, args);
        try {
          state.render?.(this);
        } catch (e) {
          console.error("Conversation Favicons:", e);
        }
        return result;
      };
      proto[method] = state.wrapper;
    }
    proto[key].render = render;
    proto[key].owner = this;
  }

  /** Como patchMethod, mas para o setter de uma propriedade. */
  patchSetter(proto, prop, render) {
    const key = `__cf_set_${prop}`;
    if (!proto[key]) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (!descriptor?.set) {
        return;
      }
      const state = { descriptor, render: null, owner: null, setter: null };
      proto[key] = state;
      state.setter = function (value) {
        descriptor.set.call(this, value);
        try {
          state.render?.(this);
        } catch (e) {
          console.error("Conversation Favicons:", e);
        }
      };
      Object.defineProperty(proto, prop, { ...descriptor, set: state.setter });
    }
    proto[key].render = render;
    proto[key].owner = this;
  }

  unpatchSetter(proto, prop) {
    const key = `__cf_set_${prop}`;
    const state = proto?.[key];
    if (!state || state.owner !== this) {
      return false;
    }
    // Mesma lógica de unpatchMethod: só repõe se o nosso setter estiver por cima.
    if (Object.getOwnPropertyDescriptor(proto, prop)?.set === state.setter) {
      Object.defineProperty(proto, prop, state.descriptor);
      delete proto[key];
    } else {
      state.render = null;
      state.owner = null;
    }
    return true;
  }

  /**
   * Desfaz o patch se esta instância for a dona; devolve se o fez.
   * Se outro add-on envolveu o método depois de nós, repor o original
   * apagaria o patch dele; nesse caso o nosso wrapper fica no lugar, inativo,
   * e é reaproveitado se o add-on voltar a ser carregado.
   */
  unpatchMethod(proto, method) {
    const key = `__cf_${method}`;
    const state = proto?.[key];
    if (!state || state.owner !== this) {
      return false;
    }
    if (proto[method] === state.wrapper) {
      proto[method] = state.original;
      delete proto[key];
    } else {
      state.render = null;
      state.owner = null;
    }
    return true;
  }

  injectStyle(doc, css) {
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = css;
      (doc.head ?? doc.documentElement).appendChild(style);
    }
  }

  refreshAll() {
    for (const win of this.listWindows) {
      win.threadTree?.invalidate();
    }
    for (const win of this.messageWindows) {
      for (const el of win.document.querySelectorAll("li.header-recipient")) {
        this.renderRecipient(el);
      }
    }
    for (const view of this.conversationViews) {
      this.renderConversation(view);
    }
    for (const win of this.calendarWindows) {
      this.renderCalendarWindow(win);
    }
    for (const win of this.addressBookWindows) {
      win.cardsPane?.cardsList?.invalidate();
    }
  }

  // ---- Lista de mensagens (about:3pane) ----

  async patchListWindow(win) {
    if (this.listWindows.has(win)) {
      return;
    }
    this.listWindows.add(win);
    win.addEventListener("unload", () => this.listWindows.delete(win), {
      once: true,
    });

    // Painel de leitura dentro do 3-pane.
    this.watchBrowser(
      win.document.getElementById("messageBrowser"),
      "about:message",
      w => this.patchMessageWindow(w)
    );
    this.patchConversationView(win);

    await win.customElements.whenDefined("thread-card");
    const proto = win.customElements.get("thread-card").prototype;
    this.patchMethod(proto, "fillRow", row => this.renderRow(row));
    this.injectStyle(win.document, LIST_CSS);
    win.threadTree?.invalidate();
  }

  unpatchListWindow(win) {
    this.unpatchMethod(
      win.customElements.get("conversation-view")?.prototype,
      "connectedCallback"
    );
    const proto = win.customElements.get("thread-card")?.prototype;
    if (!this.unpatchMethod(proto, "fillRow")) {
      return;
    }
    win.document.getElementById(STYLE_ID)?.remove();
    for (const el of win.document.querySelectorAll(`.${CONTAINER_CLASS}`)) {
      el.remove();
    }
    win.threadTree?.invalidate();
  }

  renderRow(row) {
    let container = row.querySelector(`.${CONTAINER_CLASS}`);
    if (!container) {
      container = row.ownerDocument.createElement("span");
      container.className = CONTAINER_CLASS;
      row.senderLine.after(container);
    }
    container.replaceChildren();
    container.removeAttribute("title");

    const properties = row.dataset.properties?.split(" ") ?? [];
    if (!this.settings.showInList || properties.includes("dummy")) {
      return;
    }

    const domains = this.domainsForRow(row);
    if (!domains.length) {
      return;
    }

    this.appendIcons(container, domains, Math.max(1, this.settings.maxIcons));
  }

  domainsForRow(row) {
    const none = [];
    const view = row.list?.view ?? row.view;
    const index = row._index;
    if (!view || index == null || index < 0) {
      return none;
    }
    const hdr = view.getMsgHdrAt(index);
    if (!hdr) {
      return none;
    }

    // A raiz de uma conversa representa a conversa inteira; uma linha filha
    // (conversa expandida) representa só a sua própria mensagem.
    let headers = [hdr];
    let key = null;
    if (row.classList.contains("children")) {
      try {
        const thread = view.getThreadContainingIndex(index);
        key = `${hdr.folder?.URI}|${thread.threadKey}|${thread.numChildren}`;
        const cached = this.domainCache.get(key);
        if (cached) {
          return cached;
        }
        headers = [];
        for (let i = 0; i < thread.numChildren; i++) {
          headers.push(thread.getChildHdrAt(i));
        }
        // O remetente da linha aparece primeiro.
        const isRowHdr = h => h?.messageKey == hdr.messageKey;
        headers.sort((a, b) => isRowHdr(b) - isRowHdr(a));
      } catch (e) {
        headers = [hdr];
        key = null;
      }
    }

    const ownDomains = this.settings.excludeOwnDomains
      ? this.getOwnDomains()
      : new Set();
    const fields = h =>
      this.settings.includeRecipients
        ? [h.author, h.recipients, h.ccList]
        : [h.author];
    // Os domínios atribuídos vêm primeiro (para não serem cortados pelo
    // limite de ícones) e aparecem mesmo se forem próprios ou ignorados.
    const domains = this.assignedDomains(headers);
    const seen = new Set(domains);
    for (const h of headers) {
      if (!h) {
        continue;
      }
      for (const field of fields(h)) {
        for (const domain of extractDomains(field)) {
          if (
            !seen.has(domain) &&
            !ownDomains.has(domain) &&
            !this.ignoredDomains.has(domain)
          ) {
            seen.add(domain);
            domains.push(domain);
          }
        }
      }
    }

    if (key) {
      if (this.domainCache.size > 5000) {
        this.domainCache.clear();
      }
      this.domainCache.set(key, domains);
    }
    return domains;
  }

  assignedDomains(headers) {
    const domains = new Set();
    if (!this.conversationDomains.size) {
      return [];
    }
    for (const h of headers) {
      if (!h) {
        continue;
      }
      for (const key of conversationKeys(h)) {
        for (const domain of this.conversationDomains.get(key) ?? []) {
          domains.add(domain);
        }
      }
    }
    return [...domains];
  }

  getOwnDomains() {
    if (!this.ownDomains) {
      this.ownDomains = new Set();
      for (const identity of MailServices.accounts.allIdentities) {
        const domain = baseDomain(identity.email?.split("@")[1]);
        if (domain) {
          this.ownDomains.add(domain);
        }
      }
    }
    return this.ownDomains;
  }

  // ---- Cabeçalho da mensagem (about:message) ----

  async patchMessageWindow(win) {
    if (this.messageWindows.has(win)) {
      return;
    }
    this.messageWindows.add(win);
    win.addEventListener("unload", () => this.messageWindows.delete(win), {
      once: true,
    });

    await win.customElements.whenDefined("header-recipient");
    const proto = win.customElements.get("header-recipient").prototype;
    this.patchMethod(proto, "updateRecipient", el => this.renderRecipient(el));
    this.injectStyle(win.document, MESSAGE_CSS);
    // Mensagem que já estava aberta.
    for (const el of win.document.querySelectorAll("li.header-recipient")) {
      this.renderRecipient(el);
    }
  }

  unpatchMessageWindow(win) {
    const proto = win.customElements.get("header-recipient")?.prototype;
    if (!this.unpatchMethod(proto, "updateRecipient")) {
      return;
    }
    win.document.getElementById(STYLE_ID)?.remove();
    for (const el of win.document.querySelectorAll(`.${RECIPIENT_CLASS}`)) {
      el.remove();
    }
  }

  renderRecipient(el) {
    el.querySelector(`.${RECIPIENT_CLASS}`)?.remove();
    const domain = baseDomain(el.emailAddress?.split("@")[1]);
    if (
      !this.settings.showInHeader ||
      !domain ||
      this.ignoredDomains.has(domain) ||
      !el.abIndicator
    ) {
      return;
    }
    const icon = this.createIcon(el.ownerDocument, domain);
    if (icon) {
      icon.classList.add(RECIPIENT_CLASS);
      icon.title = domain;
      // O alinhamento imita o do botão do livro de endereços.
      styleInline(icon, 14);
      // Logo a seguir ao nome, antes do botão do livro de endereços.
      el.abIndicator.before(icon);
    }
  }

  // ---- Vista de conversa (pré-visualização nativa do Thunderbird) ----

  /**
   * As mensagens recolhidas da vista de conversa vivem no shadow DOM do
   * <conversation-view>; observa-o e acrescenta o favicon ao remetente.
   * A mensagem aberta é um about:message normal, tratado pelo observer de
   * documentos.
   */
  async patchConversationView(win) {
    // O módulo só é carregado quando a vista é usada pela primeira vez.
    await win.customElements.whenDefined("conversation-view");
    if (!this.listWindows.has(win)) {
      return;
    }
    const proto = win.customElements.get("conversation-view").prototype;
    this.patchMethod(proto, "connectedCallback", view =>
      this.observeConversationView(view)
    );
    for (const view of win.document.querySelectorAll("conversation-view")) {
      this.observeConversationView(view);
    }
  }

  observeConversationView(view) {
    const main = view.shadowRoot?.querySelector("#mainConversation");
    if (!main || view.__cfObserver) {
      return;
    }
    view.__cfObserver = new view.ownerDocument.defaultView.MutationObserver(() =>
      this.renderConversation(view)
    );
    view.__cfObserver.observe(main, { childList: true });
    this.conversationViews.add(view);
    this.renderConversation(view);
  }

  renderConversation(view) {
    const main = view.shadowRoot?.querySelector("#mainConversation");
    if (!main) {
      return;
    }
    for (const article of main.querySelectorAll(
      'article[aria-expanded="false"]'
    )) {
      const address = article.querySelector("address");
      if (!address) {
        continue;
      }
      address.querySelector(`.${CONVERSATION_CLASS}`)?.remove();
      const hdr = view.messages?.find(
        m => m.messageId == article.dataset.messageId
      );
      const domain = hdr && extractDomains(hdr.author)[0];
      if (
        !this.settings.showInHeader ||
        !domain ||
        this.ignoredDomains.has(domain)
      ) {
        continue;
      }
      const icon = this.createIcon(view.ownerDocument, domain);
      if (icon) {
        icon.classList.add(CONVERSATION_CLASS);
        icon.title = domain;
        styleInline(icon, 14);
        address.appendChild(icon);
      }
    }
  }

  // ---- Calendário (janela principal) ----

  async patchCalendarWindow(win) {
    if (this.calendarWindows.has(win)) {
      return;
    }
    this.calendarWindows.add(win);
    win.addEventListener("unload", () => this.calendarWindows.delete(win), {
      once: true,
    });

    // Painel Eventos (Hoje).
    win.customElements.whenDefined("agenda-listitem").then(() => {
      if (!this.calendarWindows.has(win)) {
        return;
      }
      const proto = win.customElements.get("agenda-listitem").prototype;
      this.patchSetter(proto, "item", el => this.renderAgendaItem(el));
      this.renderCalendarWindow(win);
    });

    // Vistas de dia, semana, várias semanas e mês: todas as caixas de evento
    // herdam de calendar-editable-item e escrevem o título aqui.
    win.customElements.whenDefined("calendar-editable-item").then(() => {
      if (!this.calendarWindows.has(win)) {
        return;
      }
      const proto = win.customElements.get("calendar-editable-item").prototype;
      this.patchMethod(proto, "setEditableLabel", el => this.renderEventBox(el));
      this.renderCalendarWindow(win);
    });

    this.addEventMenu(win, "agenda-menupopup", () => [
      win.TodayPane?.agenda?.selectedItem,
    ]);
    this.addEventMenu(win, "calendar-item-context-menu", () =>
      win.currentView?.().getSelectedItems()
    );
  }

  unpatchCalendarWindow(win) {
    const agenda = win.customElements.get("agenda-listitem")?.prototype;
    const editable = win.customElements.get("calendar-editable-item")?.prototype;
    const ownsAgenda = this.unpatchSetter(agenda, "item");
    const ownsEditable = this.unpatchMethod(editable, "setEditableLabel");
    if (!ownsAgenda && !ownsEditable) {
      return;
    }
    for (const el of win.document.querySelectorAll(
      `.${EVENT_CLASS}, .${MENU_CLASS}`
    )) {
      el.remove();
    }
  }

  addEventMenu(win, popupId, getItems) {
    const popup = win.document.getElementById(popupId);
    if (!popup || popup.querySelector(`.${MENU_CLASS}`)) {
      return;
    }
    const separator = win.document.createXULElement("menuseparator");
    separator.classList.add(MENU_CLASS);
    const item = win.document.createXULElement("menuitem");
    item.classList.add(MENU_CLASS);
    item.setAttribute("label", "Assign company domains…");
    item.addEventListener("command", () => {
      const events = (getItems() ?? []).filter(Boolean);
      if (!events.length) {
        return;
      }
      // Todas as ocorrências de um evento repetido partilham o UID.
      const ids = [...new Set(events.map(e => e.id))];
      for (const fire of this.assignListeners) {
        fire.async(ids, events[0].title ?? "");
      }
    });
    popup.append(separator, item);
  }

  renderCalendarWindow(win) {
    for (const el of win.document.querySelectorAll("li.agenda-listitem")) {
      this.renderAgendaItem(el);
    }
    for (const el of win.document.querySelectorAll(
      "calendar-event-box, calendar-month-day-box-item, calendar-editable-item"
    )) {
      this.renderEventBox(el);
    }
  }

  renderAgendaItem(el) {
    this.renderEventIcons(el, el.item, el.titleElement);
  }

  renderEventBox(el) {
    this.renderEventIcons(el, el.occurrence, el.eventNameLabel);
  }

  /** Ícones do evento logo a seguir ao elemento do título. */
  renderEventIcons(el, item, titleElement) {
    el.querySelector(`.${EVENT_CLASS}`)?.remove();
    if (!this.settings.showInCalendar || !item || !titleElement) {
      return;
    }
    const domains = this.domainsForEvent(item);
    if (!domains.length) {
      return;
    }
    const doc = el.ownerDocument;
    const container = doc.createElement("span");
    container.className = EVENT_CLASS;
    Object.assign(container.style, {
      display: "inline-flex",
      flex: "none",
      alignItems: "center",
      gap: "2px",
      marginInlineStart: "4px",
      // Centrado na linha do título: o título do painel Eventos é texto
      // corrido; nas vistas do calendário está num contentor flex.
      verticalAlign: "middle",
      alignSelf: "center",
      lineHeight: "1",
    });
    this.appendIcons(container, domains, Math.max(1, this.settings.maxIcons), {
      inline: true,
    });
    titleElement.after(container);
  }

  /** Domínios atribuídos primeiro, depois organizador e participantes. */
  domainsForEvent(item) {
    const domains = [...(this.eventDomains.get(item.id) ?? [])];
    const seen = new Set(domains);
    const ownDomains = this.settings.excludeOwnDomains
      ? this.getOwnDomains()
      : new Set();
    let people = [];
    try {
      people = [item.organizer, ...(item.getAttendees?.() ?? [])];
    } catch (e) {
      // Itens sem participantes (ex.: tarefas de alguns calendários).
    }
    for (const person of people) {
      const email = person?.id?.replace(/^mailto:/i, "");
      const domain = baseDomain(email?.split("@")[1]);
      if (
        domain &&
        !seen.has(domain) &&
        !ownDomains.has(domain) &&
        !this.ignoredDomains.has(domain)
      ) {
        seen.add(domain);
        domains.push(domain);
      }
    }
    return domains;
  }

  // ---- Livro de endereços (about:addressbook) ----

  patchAddressBookWindow(win) {
    if (!win || this.addressBookWindows.has(win)) {
      return;
    }
    this.addressBookWindows.add(win);
    win.addEventListener("unload", () => this.addressBookWindows.delete(win), {
      once: true,
    });

    const apply = async () => {
      // Vista de cartões e vista de tabela da lista de contactos.
      for (const name of ["ab-card-row", "ab-table-card-row"]) {
        await win.customElements.whenDefined(name);
        if (!this.addressBookWindows.has(win)) {
          return;
        }
        const proto = win.customElements.get(name).prototype;
        this.patchMethod(proto, "fillRow", row => this.renderContactRow(row));
      }
      win.cardsPane?.cardsList?.invalidate();
    };
    if (win.document.readyState == "complete") {
      apply();
    } else {
      win.addEventListener("load", apply, { once: true });
    }
  }

  unpatchAddressBookWindow(win) {
    let owned = false;
    for (const name of ["ab-card-row", "ab-table-card-row"]) {
      const proto = win.customElements.get(name)?.prototype;
      owned = this.unpatchMethod(proto, "fillRow") || owned;
    }
    if (!owned) {
      return;
    }
    for (const el of win.document.querySelectorAll(`.${CONTACT_CLASS}`)) {
      el.remove();
    }
    win.cardsPane?.cardsList?.invalidate();
  }

  renderContactRow(row) {
    row.querySelector(`.${CONTACT_CLASS}`)?.remove();
    if (!this.settings.showInAddressBook) {
      return;
    }
    const card = row.view?.getCardFromRow(row._index);
    if (!card || card.isMailList) {
      return;
    }

    // Todos os emails do contacto, por ordem, sem repetir domínios.
    const domains = [];
    for (const email of card.emailAddresses ?? [card.primaryEmail]) {
      const domain = baseDomain(email?.split("@")[1]);
      if (
        domain &&
        !domains.includes(domain) &&
        !this.ignoredDomains.has(domain)
      ) {
        domains.push(domain);
      }
    }
    if (!domains.length) {
      return;
    }

    const doc = row.ownerDocument;
    const container = doc.createElement("span");
    container.className = CONTACT_CLASS;
    Object.assign(container.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "2px",
      marginInlineStart: "4px",
      verticalAlign: "middle",
      lineHeight: "1",
    });
    this.appendIcons(container, domains, Infinity, { inline: true });

    // Cartões: a seguir ao nome. Tabela: no fim da coluna do nome.
    if (row.name) {
      row.name.after(container);
    } else {
      (
        row.querySelector(".generatedname-column") ?? row.firstElementChild
      )?.appendChild(container);
    }
  }

  // ---- Comum ----

  /**
   * Acrescenta a `container` um ícone por favicon distinto: domínios com
   * exatamente a mesma imagem (ex.: vários domínios da mesma empresa)
   * partilham um só ícone. O tooltip lista todos os domínios.
   *
   * @param {HTMLElement} container
   * @param {string[]} domains - por ordem de prioridade.
   * @param {number} maxIcons
   * @param {object} [options]
   * @param {boolean} [options.inline] - estilo inline (sem folha injetada).
   */
  appendIcons(container, domains, maxIcons, { inline = false } = {}) {
    const doc = container.ownerDocument;
    const groups = new Map();
    for (const domain of domains) {
      const url = this.favicons.get(domain);
      const key = typeof url == "string" ? url : `domain:${domain}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(domain);
    }

    const list = [...groups.values()];
    for (const group of list.slice(0, maxIcons)) {
      const icon = this.createIcon(doc, group[0]);
      if (!icon) {
        continue;
      }
      if (inline) {
        styleInline(icon, 14);
        icon.style.marginInlineStart = "0";
        icon.style.marginBlockStart = "0";
      }
      container.appendChild(icon);
    }
    if (list.length > maxIcons) {
      const more = doc.createElement("span");
      more.className = "cf-more";
      more.textContent = `+${list.length - maxIcons}`;
      if (inline) {
        more.style.fontSize = "0.75em";
      }
      container.appendChild(more);
    }
    container.title = list.map(group => group.join(", ")).join("\n");
  }

  /** Favicon do domínio, a inicial se não tiver, ou null se ainda a caminho. */
  createIcon(doc, domain) {
    if (!this.favicons.has(domain)) {
      this.request(domain);
      return null;
    }
    const url = this.favicons.get(domain);
    if (url) {
      const img = doc.createElement("img");
      img.className = "cf-icon";
      img.src = url;
      img.alt = "";
      return img;
    }
    const letter = doc.createElement("span");
    letter.className = "cf-icon cf-letter";
    letter.textContent = domain[0];
    letter.style.backgroundColor = colorFor(domain);
    return letter;
  }

  request(domain) {
    if (this.requested.has(domain)) {
      return;
    }
    this.requested.add(domain);
    this.pending.add(domain);
    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        if (!this.listeners.size) {
          return;
        }
        const domains = [...this.pending];
        this.pending.clear();
        for (const fire of this.listeners) {
          fire.async(domains);
        }
      }, 100);
    }
  }
};

/** O Message-ID da mensagem e os das que a antecedem na conversa. */
function conversationKeys(hdr) {
  const keys = [];
  const add = id => {
    id = id?.trim().replace(/^<|>$/g, "");
    if (id) {
      keys.push(id);
    }
  };
  add(hdr.messageId);
  for (let i = 0; i < hdr.numReferences; i++) {
    add(hdr.getStringReference(i));
  }
  return keys;
}

/** Estilo inline, para sítios onde a folha de estilo injetada não chega. */
function styleInline(icon, size) {
  Object.assign(icon.style, {
    width: `${size}px`,
    height: `${size}px`,
    fontSize: `${Math.round(size * 0.65)}px`,
    borderRadius: "3px",
    verticalAlign: "middle",
    marginBlockStart: "-2px",
    marginInlineStart: "4px",
    display: icon.localName == "img" ? "inline-block" : "inline-grid",
  });
  if (icon.localName != "img") {
    Object.assign(icon.style, {
      placeItems: "center",
      color: "white",
      fontWeight: "700",
      lineHeight: "1",
      textTransform: "uppercase",
    });
  }
}

function extractDomains(header) {
  if (!header) {
    return [];
  }
  const domains = [];
  try {
    for (const addr of MailServices.headerParser.parseEncodedHeader(header)) {
      const domain = baseDomain(addr.email?.split("@")[1]);
      if (domain) {
        domains.push(domain);
      }
    }
  } catch (e) {
    // Cabeçalho mal formado: ignora.
  }
  return domains;
}

function baseDomain(host) {
  if (!host) {
    return null;
  }
  host = host.trim().toLowerCase().replace(/\.$/, "");
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch (e) {
    return host;
  }
}

function colorFor(domain) {
  let hash = 0;
  for (const ch of domain) {
    hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  }
  return `hsl(${Math.abs(hash) % 360} 55% 45%)`;
}
