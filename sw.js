'use strict';

/*
 * Service Worker — يتيح عمل الحاسبة دون إنترنت.
 * ملفات الموقع نفسه: الشبكة أولاً ثم المحفوظ عند الانقطاع.
 * الملفات الخارجية: المحفوظ فوراً ثم تحديث بالخلفية.
 */
const CACHE = 'gpa-calculator-v4';
const NETWORK_TIMEOUT_MS = 3000;

const CORE = [
    './',
    'index.html',
    'css/style.css',
    'js/script.js',
    'manifest.webmanifest'
];

const EXTERNAL = [
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => Promise.allSettled([
                ...CORE.map((url) => cache.add(url)),
                ...EXTERNAL.map((url) => cache.add(new Request(url, { mode: 'cors' })))
            ]))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || !req.url.startsWith('http')) return;
    if (req.headers.has('range')) return;

    const sameOrigin = new URL(req.url).origin === self.location.origin;
    event.respondWith(sameOrigin ? networkFirst(event) : staleWhileRevalidate(event));
});

async function networkFirst(event) {
    const req = event.request;
    const cache = await caches.open(CACHE);

    try {
        // طلب الصفحة نفسها يُمرَّر كما هو دون أي خيارات إضافية
        const request = req.mode === 'navigate' ? req : new Request(req, { cache: 'no-cache' });
        const res = await Promise.race([
            fetch(request),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS))
        ]);
        if (res.ok) event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
        return res;
    } catch (err) {
        const cached = await cache.match(req, { ignoreSearch: true });
        if (cached) return cached;
        if (req.mode === 'navigate') {
            const page = (await cache.match('index.html')) || (await cache.match('./'));
            if (page) return page;
        }
        return Response.error();
    }
}

async function staleWhileRevalidate(event) {
    const req = event.request;
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);

    const update = fetch(req)
        .then((res) => {
            if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone()).catch(() => {});
            return res;
        })
        .catch(() => null);

    if (cached) {
        event.waitUntil(update);
        return cached;
    }
    return (await update) || Response.error();
}
