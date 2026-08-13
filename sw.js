var CACHE_NAME = "law-schedule-v2";
var ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

function isPageRequest(request) {
  return request.mode === "navigate" || request.url.endsWith("/index.html") || request.url.endsWith("/");
}

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  if (isPageRequest(event.request)) {
    // 페이지 본문은 네트워크를 우선 시도해서 항상 최신 버전을 받아오고,
    // 오프라인일 때만 캐시된 마지막 버전으로 대체합니다.
    event.respondWith(
      fetch(event.request)
        .then(function (res) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, clone); });
          return res;
        })
        .catch(function () { return caches.match(event.request); })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var fetchPromise = fetch(event.request)
        .then(function (res) {
          if (res && res.ok) {
            var clone = res.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, clone); });
          }
          return res;
        })
        .catch(function () { return cached; });
      return cached || fetchPromise;
    })
  );
});
