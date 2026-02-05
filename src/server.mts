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
const RATE_LIMIT_LEADERBOARD_MAX: number = Number(process.env.RATE_LIMIT_LEADERBOARD_MAX) || 20; // 排行榜最大次数
const RATE_LIMIT_LEADERBOARD_WINDOW: number = Number(process.env.RATE_LIMIT_LEADERBOARD_WINDOW) || 300; // 排行榜窗口（秒）

// 使用 Redis 作为缓存并在 worker 刷新，见worker.js

const redis: Redis = new Redis({
    host: process.env.UPSTASH_REDIS_REST_URL,
    port: Number(process.env.UPSTASH_REDIS_PORT) || 6379,
    username: "default",
    password: process.env.UPSTASH_REDIS_REST_TOKEN,
    tls: {
        key: `${process.env.REDIS_TLS_KEY}`,
        cert: `${process.env.REDIS_TLS_CERT}`,
        ca: `${process.env.REDIS_TLS_CACERT}`
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
