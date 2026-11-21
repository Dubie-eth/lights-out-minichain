/**
 * Injected-wallet helper for MiniChain pages.
 * Discovers providers via EIP-6963, window.okxwallet, and window.ethereum
 * (including late injection). eth_requestAccounts is always the first
 * provider call from a Connect click so the user gesture is not lost.
 */
(function (global) {
  "use strict";

  var announced = [];
  var active = null;
  var listening = false;

  function onAnnounce(event) {
    var detail = event && event.detail;
    if (!detail || !detail.provider) return;
    var info = detail.info || {};
    var exists = announced.some(function (row) {
      return row.provider === detail.provider || (info.rdns && row.info && row.info.rdns === info.rdns);
    });
    if (!exists) announced.push({ info: info, provider: detail.provider });
  }

  function startDiscovery() {
    if (listening || typeof global.addEventListener !== "function") return;
    listening = true;
    global.addEventListener("eip6963:announceProvider", onAnnounce);
    try {
      global.dispatchEvent(new Event("eip6963:requestProvider"));
    } catch (e) {}
  }

  function labelOf(info) {
    return (((info && (info.rdns || info.name)) || "") + "").toLowerCase();
  }

  function pickFromAnnounced(preferOkx) {
    var i;
    if (preferOkx) {
      for (i = 0; i < announced.length; i++) {
        if (labelOf(announced[i].info).indexOf("okx") !== -1) return announced[i].provider;
      }
    }
    return announced.length ? announced[0].provider : null;
  }

  function isOkx(p) {
    return !!(p && (p.isOkxWallet || p.isOKXWallet || p === global.okxwallet));
  }

  function pickProvider() {
    startDiscovery();
    var from6963 = pickFromAnnounced(true);
    if (from6963) return from6963;
    if (global.okxwallet && typeof global.okxwallet.request === "function") return global.okxwallet;
    var eth = global.ethereum;
    if (eth && Array.isArray(eth.providers)) {
      var i;
      for (i = 0; i < eth.providers.length; i++) {
        if (isOkx(eth.providers[i]) && typeof eth.providers[i].request === "function") return eth.providers[i];
      }
      if (eth.providers[0] && typeof eth.providers[0].request === "function") return eth.providers[0];
    }
    if (eth && typeof eth.request === "function") return eth;
    return pickFromAnnounced(false);
  }

  function getActiveProvider() {
    return active || pickProvider();
  }

  var unbind = null;
  function bindEvents(provider) {
    if (unbind) {
      unbind();
      unbind = null;
    }
    if (!provider || typeof provider.on !== "function") return;
    var onAcc = function (accs) {
      if (typeof api.onAccountsChanged === "function") api.onAccountsChanged(accs);
    };
    var onChain = function (id) {
      if (typeof api.onChainChanged === "function") api.onChainChanged(id);
    };
    provider.on("accountsChanged", onAcc);
    provider.on("chainChanged", onChain);
    unbind = function () {
      if (typeof provider.removeListener === "function") {
        provider.removeListener("accountsChanged", onAcc);
        provider.removeListener("chainChanged", onChain);
      }
    };
  }

  function setActiveProvider(provider) {
    active = provider || null;
    if (provider) bindEvents(provider);
  }

  function chainIdHex(id) {
    var n = Number(id);
    if (!isFinite(n) || n <= 0) throw new Error("Missing chain id.");
    return "0x" + n.toString(16);
  }

  function sameChainId(a, b) {
    if (a == null || b == null) return false;
    return Number(a) === Number(b);
  }

  function errorText(e) {
    if (e == null) return "Wallet request failed.";
    var code = e.code;
    if (code === 4001 || code === "ACTION_REJECTED") return "You rejected the wallet request.";
    if (code === 4100) return "The wallet does not allow this request. Check that this site is permitted.";
    if (code === 4900 || code === 4901) return "The wallet is disconnected. Open it and try again.";
    if (code === "NO_WALLET") return "No wallet was detected in this browser.";
    var msg = e.shortMessage || e.message || (typeof e === "string" ? e : "");
    if (msg) return String(msg).split("\n")[0].slice(0, 280);
    try {
      return JSON.stringify(e).slice(0, 280);
    } catch (err) {
      return "Wallet request failed.";
    }
  }

  function isUnknownChain(e) {
    if (!e) return false;
    var nested = e.data && e.data.originalError && e.data.originalError.code;
    if (e.code === 4902 || nested === 4902) return true;
    return /unrecognized chain|not been added|unknown chain|4902/i.test(String(e.message || ""));
  }

  function defaultChainCfg() {
    return {
      chainId: 4663,
      chainName: "Robinhood Chain",
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      explorer: "https://explorer.chain.robinhood.com",
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }
    };
  }

  function normalizeCfg(chainCfg) {
    var d = defaultChainCfg();
    var cfg = chainCfg || {};
    return {
      chainId: cfg.chainId || d.chainId,
      chainName: cfg.chainName || d.chainName,
      rpc: cfg.rpc || d.rpc,
      explorer: cfg.explorer || d.explorer,
      nativeCurrency: {
        name: (cfg.nativeCurrency && cfg.nativeCurrency.name) || "ETH",
        symbol: (cfg.nativeCurrency && cfg.nativeCurrency.symbol) || "ETH",
        decimals: (cfg.nativeCurrency && cfg.nativeCurrency.decimals != null) ? cfg.nativeCurrency.decimals : 18
      }
    };
  }

  async function switchOrAddChain(provider, chainCfg) {
    var cfg = normalizeCfg(chainCfg);
    var hexId = chainIdHex(cfg.chainId);
    var current = await provider.request({ method: "eth_chainId" }).catch(function () { return null; });
    if (sameChainId(current, hexId) || sameChainId(current, cfg.chainId)) return hexId;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: cfg.chainName,
          nativeCurrency: cfg.nativeCurrency,
          rpcUrls: [cfg.rpc],
          blockExplorerUrls: cfg.explorer ? [cfg.explorer] : []
        }]
      });
    }
    return hexId;
  }

  /**
   * Connect a discovered provider. When called from a click and a provider
   * is already in hand, the first awaited provider RPC is eth_requestAccounts.
   */
  async function requestAccountsAndSwitch(chainCfg, provider) {
    var p = provider || pickProvider();
    if (!p || typeof p.request !== "function") {
      var err = new Error("No wallet was detected in this browser.");
      err.code = "NO_WALLET";
      throw err;
    }
    setActiveProvider(p);
    var accs = await p.request({ method: "eth_requestAccounts" });
    var account = accs && accs[0];
    if (!account) throw new Error("Wallet did not return an account.");
    var hexId = await switchOrAddChain(p, chainCfg);
    var net = await p.request({ method: "eth_chainId" }).catch(function () { return null; });
    var cfg = normalizeCfg(chainCfg);
    return {
      account: account,
      provider: p,
      chainId: net != null ? Number(net) : cfg.chainId,
      chainOk: sameChainId(net, hexId) || sameChainId(net, cfg.chainId)
    };
  }

  function deepLinks(pageUrl) {
    var url = pageUrl || (global.location && global.location.href) || "";
    return {
      okx: "okx://wallet/dapp/url?dappUrl=" + encodeURIComponent(url),
      metamask: "https://metamask.app.link/dapp/" + url.replace(/^https?:\/\//, ""),
      coinbase: "https://go.cb-w.com/dapp?cb_url=" + encodeURIComponent(url)
    };
  }

  function bindPicker(root, pageUrl) {
    if (!root) return;
    var links = deepLinks(pageUrl);
    var map = { okx: links.okx, metamask: links.metamask, coinbase: links.coinbase };
    var nodes = root.querySelectorAll("[data-wallet]");
    var i;
    for (i = 0; i < nodes.length; i++) {
      var href = map[nodes[i].getAttribute("data-wallet")];
      if (href) nodes[i].setAttribute("href", href);
    }
  }

  function showPicker(root, show, pageUrl) {
    if (!root) return;
    if (show) {
      bindPicker(root, pageUrl);
      root.hidden = false;
      root.classList.add("open");
    } else {
      root.hidden = true;
      root.classList.remove("open");
    }
  }

  function watchInjection(cb, ms) {
    startDiscovery();
    if (pickProvider()) {
      if (cb) cb(pickProvider());
      return function () {};
    }
    var deadline = Date.now() + (ms || 2500);
    var timer = setInterval(function () {
      try { global.dispatchEvent(new Event("eip6963:requestProvider")); } catch (e) {}
      var p = pickProvider();
      if (p || Date.now() > deadline) {
        clearInterval(timer);
        if (p && cb) cb(p);
      }
    }, 100);
    return function () { clearInterval(timer); };
  }

  startDiscovery();
  watchInjection(null, 3000);

  var api = {
    startDiscovery: startDiscovery,
    pickProvider: pickProvider,
    hasInjectedWallet: function () { return !!pickProvider(); },
    getActiveProvider: getActiveProvider,
    setActiveProvider: setActiveProvider,
    requestAccountsAndSwitch: requestAccountsAndSwitch,
    switchOrAddChain: switchOrAddChain,
    errorText: errorText,
    chainIdHex: chainIdHex,
    deepLinks: deepLinks,
    showPicker: showPicker,
    bindPicker: bindPicker,
    watchInjection: watchInjection,
    defaultChainCfg: defaultChainCfg,
    onAccountsChanged: null,
    onChainChanged: null
  };

  global.MiniChainWallet = api;
})(typeof window !== "undefined" ? window : this);
