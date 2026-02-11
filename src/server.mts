import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Redis } from 'ioredis';
import { createCaptchaChallengeHandler, createRateLimitMiddleware } from './altcha.mts';
import { createGetViewHandler } from './bili.mts';
import { createRefreshLeaderBoardHandler, createGetLeaderBoardHandler } from './leaderboard.mts';
import { createGetStatusHandler } from './status.mts';
import { createPostVoteHandler, createPostUnvoteHandler } from './vote.mts';
import { createJwtAuthMiddleware, createTokenFavNameHandler, createTokenVerifyHandler } from './token.mts';

const app: express.Application = express();

// 频率限制配置
const RATE_LIMIT_VOTE_MAX: number = Number(process.env.RATE_LIMIT_VOTE_MAX) || 10; // 投票最大次数
const RATE_LIMIT_VOTE_WINDOW: number = Number(process.env.RATE_LIMIT_VOTE_WINDOW) || 300; // 投票窗口（秒）
// 使用 Redis 作为缓存并在 worker 刷新，见worker.js

const redis: Redis = new Redis({
    host: process.env.UPSTASH_REDIS_REST_URL,
    port: Number(process.env.UPSTASH_REDIS_PORT) || 6379,
    username: "default",
    password: process.env.UPSTASH_REDIS_REST_TOKEN,
    tls: {
        key: `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDKEIieIrcJGhke
oOKvsOAcyvBtu2LYwYOTaOTqtHOhFLDjAsEY+Qzsgesle9Aca3nanly+ukft3WOt
6PLUTe8wNB0CvEycu56pA+muxvJyBv94BZxOplOk1pCHFQ18Fa/z9F2ulIdqQHaB
P/XZDuhASjeeJN516HGT+Ee3WF8sO5bBGSCDMr7Vs6MPfiisBXzoL13hYUd4TsYS
iVYoAi+/sYZXWSahWgi/WvqKa+Fs+0NCImqiByDuWUcWcqsJzP72JlS6a1Kgomyt
ivs0cjw+W1EoVW5elHb2Mqn7g0Xi3JxnHhocqiWDDGVwGKLnt5tHdUc3NjGyHoey
B+4qtVwnAgMBAAECggEAGatXB6vGT9Ayb7slgQc5uT6oo3ACIyIWOnRBXHWXGNf9
jqErcaY115e7jRP5AJtArB6hDpOwjo2o249zxbeu0pNUOiQ8oU6OXc9C8PKSGx07
d/5SeIVVq+OcEaUBhQlmRFn/Sq3QtBVDWLEM5MmphH1JKnxpjFX+k7sfNTHzSTWA
44EaUQ0AK9WeUx5X+8ITZyaOegWtd0aFokH4v777Jea2UbhaQABeeT8cgzzL9CJG
87oyHmp1yyRW3O8MVXuIO9f88FdKmCvQiTQ6BTE8CCmKOKqS2dAN3FVoQD/y5bqD
m/KxN38eyzFcwc0oBcpPMYB2HTzjSflQJDABS9YuIQKBgQDre0GezuuC4VCcsXS5
rwOkiD39YNSwnqVOHLyRagek1gRKcjI3V7S9+rLInPJvGBPib/mTfnmmPDYbSqr/
qU1gGptlGP1iWCpl8CICuFflYfZW1SRfdI/PnYePZV6zlMLs3ZrpIIWpiuXF52y3
uQRBSBxVFUFGNiWwvri0hBzuIQKBgQDbq93wTaTfh0vR5wSeQvl5/9qSntUEx22i
TuQ+vz9odleDvfUTh53OM2l1lHJiRHoQLopB9QbyRnNdM3u9/pUvKn/D+O8KNJ+M
NHYzfpIB0/ePukC9Wy1URCp+dEBdLk8GT82JgVYek0Y4HspVssHF9nDdaskSM44j
LUwiq7sxRwKBgQCVSj5O/WZIQqqFvOeAtRk9HXcXhWUyWFH61LMkCbGw6lIsFHwL
pBode6wPDZmRnxU0MMNso/lhz7iJ0uvYTDCW5idwj8hMqhKvL++QA+kNru6rHFQE
BHUMLhX8bkr81SpDWzdT5192Hm4P6ul9DNpKvPnhYylP5xI8HJ4jK8LfoQKBgD3t
2gfhG9YYontukZK8dvC5/LjRJmTOhE35x8cYy5t7oXh2mR0EYqy7OcP4Mbcabv8Y
38lwdqDe06820G/j0dMWPCbXiyxpYYF5WMlzqV3ykBxo+c9oYQMcpI4539tlLsos
vVlCqTC9fFJd+9TlLFPPAkqpzD3hYvTv1EMB/ygJAoGBAOCeWWOnDTX83vVWHk7E
U9uE54eNniMPf8Hja930wsSFe8rWzruR6mdBjp2vWdTYObwR48fEcnXbesaWvNAQ
+dj3OGTz/H2/JgbA6zqYI3rwnRd73nhQ2FqYhVqEt7Q+V87j5HytwR5r47OiealA
Rb+mcWgZ6ssVpxI9vuYuRP6z
-----END PRIVATE KEY-----`,
        cert: `-----BEGIN CERTIFICATE-----
MIID5TCCAc0CFDUaIe1SJ6RX0ktehCwiw/1/AjQ+MA0GCSqGSIb3DQEBCwUAMDUx
EzARBgNVBAoMClJlZGlzIFRlc3QxHjAcBgNVBAMMFUNlcnRpZmljYXRlIEF1dGhv
cml0eTAeFw0yNjAxMTQyMDMxNDJaFw0yNzAxMTQyMDMxNDJaMCkxEzARBgNVBAoM
ClJlZGlzIFRlc3QxEjAQBgNVBAMMCSoudnRicy5haTCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBAMoQiJ4itwkaGR6g4q+w4BzK8G27YtjBg5No5Oq0c6EU
sOMCwRj5DOyB6yV70BxredqeXL66R+3dY63o8tRN7zA0HQK8TJy7nqkD6a7G8nIG
/3gFnE6mU6TWkIcVDXwVr/P0Xa6Uh2pAdoE/9dkO6EBKN54k3nXocZP4R7dYXyw7
lsEZIIMyvtWzow9+KKwFfOgvXeFhR3hOxhKJVigCL7+xhldZJqFaCL9a+opr4Wz7
Q0IiaqIHIO5ZRxZyqwnM/vYmVLprUqCibK2K+zRyPD5bUShVbl6UdvYyqfuDReLc
nGceGhyqJYMMZXAYoue3m0d1Rzc2MbIeh7IH7iq1XCcCAwEAATANBgkqhkiG9w0B
AQsFAAOCAgEAXEvtTbj6mTJ0EgPN3ZTaNoQ+zaYy2MIpOgJCqxV6lK5MXFSIcQt1
7ImIEjAC59U+IIpC8sBXuZVI+dgZqSVICpUyx0PyQWR9Nml9jpTEFmAJj4Ibbg4p
VI+TSafJ20BRMSV1vbboVU+zpVvoN2aNNfFdqYNOi1mIKvcZyd9CHvIJInq2T/2O
iJ/IeJRNugnq8r6rkKjmct6m2wyoffm9TwxHUHAkB3Fd9nGKJdnU5mEduCXNNhrr
/tNkfl9+u4hDGWu9LDTgIwbcvEcXhjhkR7r+uU15wNxu7zZgIx3mkwkC+iDN92xj
ntcBOsAVo5VJnq3V29HFI/hb9w7vq+8mD86hQ8EI0z5CNRgn4wkgHAYYfG4TGATA
skJoMA7YvgVUV60n45VgzA82mJzl5PWiiZrS86jGJwqgqTUgNGWt8kQpZu0hWltN
lVgw6rkN6/6O7M266QMNFJkbG45ezg0LZlon1FAq6VFaIiZ3ZBzzxs1zwXRoW2X/
Agc515gdpDraGT/9tTkbpN6/4+lSiOKpS4MEQzzdxuSylpyXC7MjP/DsWwkUFpT+
vv+qB500XvP2fw2av/6EHZC7r/gZTpQGA52le9hQzPqBgNd/W2oSysw077M8Y1BJ
UUWtm/FJxdgAc67qanryKHBFg6hq47Rz7mtZ3VBxEOPWv8vfw+vMkXE=
-----END CERTIFICATE-----`,
        ca: `-----BEGIN CERTIFICATE-----
MIIFSzCCAzOgAwIBAgIUTebTD065ZLk8ek0keQiZL1caS5wwDQYJKoZIhvcNAQEL
BQAwNTETMBEGA1UECgwKUmVkaXMgVGVzdDEeMBwGA1UEAwwVQ2VydGlmaWNhdGUg
QXV0aG9yaXR5MB4XDTI2MDExNDIwMzEzOFoXDTM2MDExMjIwMzEzOFowNTETMBEG
A1UECgwKUmVkaXMgVGVzdDEeMBwGA1UEAwwVQ2VydGlmaWNhdGUgQXV0aG9yaXR5
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEArAUg/0q38o0JriYPu5b8
0MerlUGN7KLF64PGvLE3DnucnWGy3eG7ihvfYb7gs7ETDVzSS/S+fWtSsfI5132L
zD0jZ4qM4bRQoSR1/MabqLyonbKamNPAtjdfoAAaw0zowR7DPVCq4AfrQ2MDD3Ld
3u9l7UABlLl8CNcwpvHShFPhvGJN/a2WejipbD8Z9mXa4YXfvvTYIcxLSzQ67Tbl
ggNFQdSAXuoDJFDXsGrXvGsM+oe9+33XAWn6hco2jrdImrYW92VR4ba4CZac4ynT
O2f/PrlBoCA9t33P6onBMqejEUiWpZgMtgxAG8FR4w48Xu1e58jhOYZGgKhs5Tq5
h9uKkVUqmmAyXqH8oVp+PhFBjgxTJxGldhtTohtLfxNsxE7a6SwThXptmiKoNkwO
/XFgYJ2pcF9AnxOv341I0tN+I+Gej3lMFT2zyXZWHULK2CTC1fiun4nq+TZjIJNd
WP07m61Gup4eotHvRnPs5hD0g78KdszP/OrL16BF88nMSkBPWdeFkbtcGZYKMgQY
fpe0d7oy2V7ZFD4VJ+ed3XCUuoywfG38zLbbnOGSpmX6xWcbHNyJ2tZhYB2sQB4q
I+HmjmPUOpnKnrnL3UcRhSIIjpYTcylKGfOs7fP2roDSbxK0wU2nUobpfysmJlXD
56FsCgfH+3dB55O92WmsOgECAwEAAaNTMFEwHQYDVR0OBBYEFKvhblN4ywjG1ede
j1k8N5wbZzwyMB8GA1UdIwQYMBaAFKvhblN4ywjG1edej1k8N5wbZzwyMA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggIBAAY5UvrjVD/FPBuRheP5vM8R
Zw92K1cZk7ppJjB+xS5V31YXs3eirla3gNXQneT+IKM3UEAsX6UxMdiBd1ae9cwv
Vt7cvPFd0Mzxg8qJJSdCYAlaFjpSdA5mpE/081i+33eCaz/SsgolQxxb8fZuLD0L
9qCpyVRRJc+xkcnwlspJnnuLqSqbiRGeZgRFbMvZawwsNocH4izCtmpxrplZ/Edj
htKUvBwOkwpbMW0ust3d2Rrisg/9chN1/63cLB2cqjQiFvp7gtQIS4GNYDetO71C
SOxVsT1RwACJn93nKOiRMJQhpjDWaeoQayaon5kSZeeXjNKSGb3nWD0Tz1EDfMGF
aY7zS7nwCsJm0HwGyea+8HZeKj4U3IjqfW7fvXG6q9MQVVgQdETnmU9XdcW33Ojw
gujy5Eh3gbVYAWRpu3HxIsynJeqhVe2vqFwDRcFB7Whitlni5u1Cf5W0nHw9fhI6
w0a9oKKv4YvwRndOaFLHFamw5equkXFyi0jcMZ7+3JAzpJJsuNML//Pg19oSLGvw
H6/b+n8VftBts/JFLnoIESKbWsXn9MTvERFjrPL9eFtbqN8SqJ1AKAXYHKDPV892
i+Id6ldyozZST44cs/2XFYCYq6hv5Git40DkZDYsAFbFBiHK1O0o0vi7Pj9CaECA
nbgpUHkxVYj0uTslf0I7
-----END CERTIFICATE-----`
    }
});

// 服务器逻辑区

app.use(cors({
    origin: [
        'https://www.bilibili.com',
        'https://web.bili-qml.com',
        'https://bilitest.vhuds.com',
        'http://127.0.0.1:5500',
        'http://localhost:5500',
        /^chrome-extension:\/\/.+$/,
        /^moz-extension:\/\/.+$/
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json());

// 安全中间件：检查请求头，增加简单的防刷逻辑
const securityCheck = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const userAgent: string = req.headers['user-agent'] || '';

    // 1. 拦截自动化工具 (开源安全型：不依赖秘密令牌)
    const ua: string = userAgent.toLowerCase();
    const botKeywords: string[] = ['curl', 'python', 'httpclient', 'axios', 'fetch', 'go-http', 'wget', 'postman', 'scrapy', 'java', 'okhttp', 'httpie', 'restclient', 'reqable', 'unirest', 'httpx', 'php', 'ruby', 'perl'];
    if (botKeywords.some(kw => ua.includes(kw))) {
        return res.status(403).json({ success: false, error: 'Access Denied' });
    }

    // 2. 内容清洗与安全过滤
    if (req.method === 'POST' && req.body) {
        let { title, bvid, userId } = req.body;

        // 校验 BVID 格式（简单正则）
        if (bvid && !/^BV[a-zA-Z0-9]{10}$/.test(bvid)) {
            return res.status(400).json({ success: false, error: 'Invalid BVID' });
        }

        // 校验 userId 格式（数字字符串）
        if (userId && !/^\d+$/.test(userId)) {
            return res.status(400).json({ success: false, error: 'Invalid User ID' });
        }
    }

    next();
};

app.use(securityCheck); // 应用到所有路由

// 禁用所有 API 的缓存
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

// 根路径欢迎页
app.get('/', (req: express.Request, res: express.Response) => {
    res.send('<h1>B站问号榜服务器已启动 ❓</h1><p>已连接至云数据库。</p>');
});

// 处理浏览器自动请求 favicon 的问题，防止 404 报错
app.get('/favicon.ico', (req: express.Request, res: express.Response) => res.status(204).end());

// 处理 robots.txt，告诉爬虫哪些可以爬
app.get('/robots.txt', (req: express.Request, res: express.Response) => {
    res.type('text/plain');
    res.send("User-agent: *\nDisallow: /api/\nDisallow: /vote\nAllow: /");
});

// 处理常见的恶意扫描路径，直接返回 404，防止产生大量警告日志
const scannerPaths: string[] = [
    '/wp-admin',
    '/wordpress',
    '/.env',
    '/.git',
    '/phpmyadmin',
    '/xmlrpc.php',
    '/setup-config.php'
];

app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (scannerPaths.some(p => req.path.toLowerCase().includes(p.toLowerCase()))) {
        return res.status(404).end();
    }
    next();
});

// EdgeOne Pages不支持定时任务自动刷新，提供手动刷新接口，由外部定时任务调用
app.get(["/api/refresh", "/refresh"], createRefreshLeaderBoardHandler(redis));

app.get(['/api/ping', '/ping'], async (req: express.Request, res: express.Response) => {
    const authHeader: string | undefined = req.headers["authorization"];
    const token: string | undefined = authHeader && authHeader.split(" ")[1];
    // simple token check
    if (!token || token !== process.env.REFRESH_TOKEN) {
        return res.status(403).json({ status: 'Forbidden' });
    }
    res.json({ status: await redis.ping() });
});

app.get(['/api/x/web-interface/view', '/x/web-interface/view'], createGetViewHandler());

// Altcha 挑战端点
app.get(['/api/altcha/challenge', '/altcha/challenge'], createCaptchaChallengeHandler());

// Token 端点
app.post(['/api/token/fav-name', '/token/fav-name'], createTokenFavNameHandler());
app.post(['/api/token/verify', '/token/verify'], createTokenVerifyHandler());

// 处理投票
app.post(['/api/vote', '/vote'],
    createRateLimitMiddleware(redis, {
        max: RATE_LIMIT_VOTE_MAX,
        window: RATE_LIMIT_VOTE_WINDOW,
        keyGenerator: (req) => {
            const client: string = (req.headers['x-vercel-forwarded-for'] as string) || req.body.userId || '';
            return `ratelimit:vote:${client}`;
        }
    }),
    createJwtAuthMiddleware(),
    createPostVoteHandler(redis)
);

app.post(['/api/unvote', '/unvote'],
    createRateLimitMiddleware(redis, {
        max: RATE_LIMIT_VOTE_MAX,
        window: RATE_LIMIT_VOTE_WINDOW,
        keyGenerator: (req) => {
            const client: string = (req.headers['x-vercel-forwarded-for'] as string) || req.body.userId || '';
            return `ratelimit:vote:${client}`;
        }
    }),
    createJwtAuthMiddleware(),
    createPostUnvoteHandler(redis)
);

// 获取状态
app.get(['/api/status', '/status'], createGetStatusHandler(redis));

// 获取排行榜
app.get(['/api/leaderboard', '/leaderboard'], createGetLeaderBoardHandler(redis));

// app.listen(3000);
export default app;
