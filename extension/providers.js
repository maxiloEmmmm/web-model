// provider 适配器注册表入口。
//
// 这个文件只负责聚合已经拆分到 providers/ 目录下的 provider 定义，
// 不再承载具体站点的 DOM 实现细节。
(function registerWebModelProviders(globalScope) {
  const shared = globalScope.WEB_MODEL_PROVIDER_SHARED;
  if (!shared || typeof shared.listProviders !== "function") {
    throw new Error("web-model provider shared registry is unavailable");
  }

  const providers = shared.listProviders();
  const api = {
    list() {
      return providers.slice();
    },
    resolveByURL(url) {
      return providers.find((provider) => provider.matchesURL(url)) || null;
    },
    hostPatterns() {
      return providers.flatMap((provider) => provider.hostPatterns || []);
    }
  };

  globalScope.WEB_MODEL_PROVIDERS = api;
})(typeof self !== "undefined" ? self : globalThis);
