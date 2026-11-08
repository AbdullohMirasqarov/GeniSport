"use strict";

const CACHE_NAME = "genisport-v3";
const SHELL = [
  "/",
  "/static/css/style.css",
  "/static/js/camera.js",
  "/static/js/pose.js",
  "/static/js/app.js",
  "/static/vendor/pose/pose.js",
  "/static/icons/genisport.svg",
  "/static/icons/genisport-192.png",
  "/static/icons/genisport-512.png",
  "/static/icons/maskable-192.png",
  "/static/icons/maskable-512.png",
  "/static/icons/maskable.svg",
  "/manifest.webmanifest"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(SHELL.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith("genisport-") && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      event.waitUntil(fetch(request).then(response => {
        if (response.ok) return caches.open(CACHE_NAME).then(cache => cache.put(request, response));
      }).catch(() => {}));
      return cached;
    }

    try {
      const response = await fetch(request);
      if (response.ok && (request.destination === "script" || request.destination === "style" ||
          url.pathname.startsWith("/static/vendor/pose/"))) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
      }
      return response;
    } catch (error) {
      if (request.mode === "navigate") {
        const app = await caches.match("/");
        if (app) return app;
      }
      return new Response("This GeniSport resource is not available offline yet.", {
        status: 503,
        headers: {"Content-Type": "text/plain; charset=utf-8"}
      });
    }
  })());
});
