var CACHE_NAME = "law-schedule-v4";
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

  // Supabase API, realtime websocket, CDN 스크립트 등 외부 origin 요청은
  // 캐시 로직을 타지 않고 그대로 네트워크로 흘려보냅니다.
  if (new URL(event.request.url).origin !== self.location.origin) return;

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

self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  var title = data.title || "일정관리";
  var options = {
    body: data.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/favicon-32.png",
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if ("focus" in clientList[i]) return clientList[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});
