import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Redis } from 'ioredis';
import { createChallenge, verifySolution } from 'altcha-lib';
import type { Challenge } from 'altcha-lib/types';

const app: express.Application = express();

const TIMESTAMP_EXPIRE_MS: number = Number(process.env.TIMESTAMP_EXPIRE_MS) || 180 * 24 * 3600 * 1000; //排行榜总数据过期时间
const leaderboardTimeInterval: number[] = [12 * 3600 * 1000, 24 * 3600 * 1000, 7 * 24 * 3600 * 1000, 30 * 24 * 3600 * 1000]; //排行榜相差时间

// Altcha 配置
const ALTCHA_HMAC_KEY: string = process.env.ALTCHA_HMAC_KEY || 'bili-qml-default-hmac-key-change-in-production';
const ALTCHA_COMPLEXITY: number = Number(process.env.ALTCHA_COMPLEXITY) || 250000; // PoW 难度

// 频率限制配置
const RATE_LIMIT_VOTE_MAX: number = Number(process.env.RATE_LIMIT_VOTE_MAX) || 10; // 投票最大次数
const RATE_LIMIT_VOTE_WINDOW: number = Number(process.env.RATE_LIMIT_VOTE_WINDOW) || 300; // 投票窗口（秒）
const RATE_LIMIT_LEADERBOARD_MAX: number = Number(process.env.RATE_LIMIT_LEADERBOARD_MAX) || 20; // 排行榜最大次数
const RATE_LIMIT_LEADERBOARD_WINDOW: number = Number(process.env.RATE_LIMIT_LEADERBOARD_WINDOW) || 300; // 排行榜窗口（秒）

// Redis Lua 脚本预加载
const statusScriptLua: string = `return {redis.call('sismember', KEYS[1], ARGV[1]), redis.call('hget', KEYS[2], ARGV[2])}`;
const statusScriptSha: string = "f0c6a6a82f3fa5cd22bb667e27c5ba1b1fcdbd33";

const voteScriptLua: string = `local voted = redis.call('sadd', KEYS[1], ARGV[1])\nif voted == 1 then\n    redis.call('hincrby', KEYS[2], ARGV[2], 1)\n    redis.call('zadd', KEYS[3], ARGV[3], ARGV[4])\nend\nreturn voted`;
const voteScriptSha: string = "fdd1c85ca528240976fa7af8fcce32536eadc271";

const unvoteScriptLua: string = `local isMember = redis.call('sismember', KEYS[1], ARGV[1])\nif isMember == 1 then\n    redis.call('srem', KEYS[1], ARGV[1])\n    redis.call('zrem', KEYS[2], ARGV[2])\n    redis.call('hincrby', KEYS[3], ARGV[3], -1)\nend\nreturn isMember`;
const unvoteScriptSha: string = "8c7c993d5352c20a6d0d270d862cc50c00a6cacd";

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
// 频率限制器：检查并增加计数
async function checkRateLimit(key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    const current: number = await redis.incr(key);
    if (current === 1) {
        await redis.expire(key, windowSeconds);
    }
    return current > maxRequests;
}

// 重置频率限制（CAPTCHA 验证通过后）
async function resetRateLimit(key: string) {
    await redis.del(key);
}

// Rate Limit 中间件工厂函数
interface RateLimitOptions {
    max: number;
    window: number;
    keyGenerator: (req: express.Request) => string;
}

function createRateLimitMiddleware(options: RateLimitOptions): express.RequestHandler {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            const key: string = options.keyGenerator(req);
            const isRateLimited: boolean = await checkRateLimit(key, options.max, options.window);

            // 存储到 res.locals 供后续处理器使用
            res.locals.rateLimitKey = key;
            res.locals.isRateLimited = isRateLimited;

            // 如果未被限制，直接放行
            if (!isRateLimited) {
                return next();
            }

            // 如果被限制，检查是否有 CAPTCHA 解决方案
            const altcha: string | undefined = req.body?.altcha || req.query?.altcha as string | undefined;

            if (altcha) {
                const isValid: boolean = await verifySolution(altcha, ALTCHA_HMAC_KEY);
                if (!isValid) {
                    return res.status(400).json({ success: false, error: 'Invalid CAPTCHA', requiresCaptcha: true });
                }
                // CAPTCHA 验证通过，重置频率限制
                await resetRateLimit(key);
                return next();
            }

            // 没有 CAPTCHA，要求客户端完成验证
            return res.status(429).json({ success: false, error: 'Rate limit exceeded', requiresCaptcha: true });
        } catch (error: any) {
            console.error('Rate Limit Middleware Error:', error);
            return res.status(500).json({ success: false, error: 'Rate limit check failed' });
        }
    };
}

async function getLeaderBoardFromTime(periodMs: number = 24 * 3600 * 1000, limit: number = 30): Promise<{ bvid: string, count: number }[]> {
    const now: number = Date.now();
    const minTime: number = now - periodMs;
    const counts: { [key: string]: number } = {};
    const [_, recentVotes] = await Promise.all([
        redis.zremrangebyscore('votes:recent', '-inf', now - TIMESTAMP_EXPIRE_MS - 1),
        redis.zrangebyscore('votes:recent', minTime, now)
    ]);
    for (const member of recentVotes) {
        const bvid: string = member.split(':')[0];  // 从 `${bvid}:${userId}` 提取
        counts[bvid] = (counts[bvid] || 0) + 1;
    }
    const sorted: [string, number][] = Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit);
    return sorted.map((array) => { return { bvid: array[0], count: array[1] } });
}

async function getCachedLeaderBoard(range: string): Promise<{ bvid: string, count: number }[] | null> {
    try {
        const response: string | null = await redis.hget('caches:leaderboard', range);
        if (!response) {
            console.warn(`No cached leaderboard found for range: ${range}`);
            return null;
        }
        return JSON.parse(response);
    } catch (error) {
        console.error(`Error fetching cached leaderboard for ${range}:`, error);
        return null;
    }
}

async function getLeaderBoard(range: string): Promise<{ bvid: string, count: number }[] | null> {
    return await getCachedLeaderBoard(range);
}

async function executeStatusScript(bvid: string, userId: string): Promise<[number, string | null]> {
    try {
        return await redis.evalsha(statusScriptSha, 2, `voted:${bvid}`, `video:${bvid}`, userId || '', 'votesTotal') as Promise<[number, string | null]>;
    } catch {
        // 脚本丢失
        try {
            const [_, res] = await Promise.all([
                redis.script("LOAD", statusScriptLua),
                redis.evalsha(statusScriptSha, 2, `voted:${bvid}`, `video:${bvid}`, userId || '', 'votesTotal')
            ]);
            return res as Promise<[number, string | null]>;
        } catch (err: any) {
            err.message = `Load Script Error: ${err.message}, check script sha values.`;
            throw err;
        }

    }
}

async function executeVoteScript(bvid: string, userId: string, timestamp: number): Promise<number> {
    try {
        return await redis.evalsha(voteScriptSha, 3, `voted:${bvid}`, `video:${bvid}`, 'votes:recent', userId, 'votesTotal', timestamp, `${bvid}:${userId}`) as Promise<number>;
    } catch {
        try {
            const [_, res] = await Promise.all([
                redis.script("LOAD", voteScriptLua),
                redis.evalsha(voteScriptSha, 3, `voted:${bvid}`, `video:${bvid}`, 'votes:recent', userId, 'votesTotal', timestamp, `${bvid}:${userId}`)
            ]);
            return res as Promise<number>;
        } catch (err: any) {
            err.message = `Load Script Error: ${err.message}, check script sha values.`;
            throw err;
        }
    }
}

async function executeUnvoteScript(bvid: string, userId: string): Promise<number> {
    try {
        return await redis.evalsha(unvoteScriptSha, 3, `voted:${bvid}`, 'votes:recent', `video:${bvid}`, userId, `${bvid}:${userId}`, 'votesTotal') as Promise<number>;
    } catch {
        try {
            const [_, res] = await Promise.all([
                redis.script("LOAD", unvoteScriptLua),
                redis.evalsha(unvoteScriptSha, 3, `voted:${bvid}`, 'votes:recent', `video:${bvid}`, userId, `${bvid}:${userId}`, 'votesTotal')
            ]);
            return res as Promise<number>;
        } catch (err: any) {
            err.message = `Load Script Error: ${err.message}, check script sha values.`;
            throw err;
        }
    }
}

// 服务器逻辑区

app.use(cors({
    origin: [
        'https://www.bilibili.com',
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
app.get(["/api/refresh", "/refresh"], async (req: express.Request, res: express.Response) => {
    const authHeader: string | undefined = req.headers["authorization"];
    const token: string | undefined = authHeader && authHeader.split(" ")[1];
    // simple token check
    if (!token || token !== process.env.REFRESH_TOKEN) {
        return res.status(403).json({ success: false, error: "Token missing" });
    }
    try {
        const leaderBoardCaches: { bvid: string, count: number }[][] = await Promise.all(leaderboardTimeInterval.map((time) => {
            return getLeaderBoardFromTime(time);
        }));
        console.log('Leaderboard cache updated.');
        await Promise.all([
            redis.hset('caches:leaderboard', 'realtime', JSON.stringify(leaderBoardCaches[0])),
            redis.hset('caches:leaderboard', 'daily', JSON.stringify(leaderBoardCaches[1])),
            redis.hset('caches:leaderboard', 'weekly', JSON.stringify(leaderBoardCaches[2])),
            redis.hset('caches:leaderboard', 'monthly', JSON.stringify(leaderBoardCaches[3])),
        ]);
        return res.json({ success: true });
    } catch (error: any) {
        console.error('Leaderboard Cache Update Error:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Altcha 挑战端点
app.get(['/api/altcha/challenge', '/altcha/challenge'], async (req: express.Request, res: express.Response) => {
    try {
        const challenge: Challenge = await createChallenge({
            hmacKey: ALTCHA_HMAC_KEY,
            maxNumber: ALTCHA_COMPLEXITY,
            algorithm: 'SHA-256',
        });
        res.json(challenge);
    } catch (error) {
        console.error('Altcha Challenge Error:', error);
        res.status(500).json({ success: false, error: 'Failed to create challenge' });
    }
});

// 处理投票
app.post(['/api/vote', '/vote'],
    createRateLimitMiddleware({
        max: RATE_LIMIT_VOTE_MAX,
        window: RATE_LIMIT_VOTE_WINDOW,
        keyGenerator: (req) => `ratelimit:vote:${req.body.userId}`
    }),
    async (req, res) => {
        try {
            const { bvid, userId }: { bvid?: string; userId?: string } = req.body;

            // 1. 基础参数校验
            if (!bvid || !userId) return res.status(400).json({ success: false, error: 'Missing params' });

            // 2. 用户投票记录（使用 Lua 脚本原子操作）
            const now: number = Date.now();
            const voted: number = await executeVoteScript(String(bvid), String(userId), now);
            if (voted === 0) return res.status(400).json({ success: false, error: 'Already Voted' });
            res.json({ success: true });
        } catch (error: any) {
            console.error('Vote Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);

app.post(['/api/unvote', '/unvote'],
    createRateLimitMiddleware({
        max: RATE_LIMIT_VOTE_MAX,
        window: RATE_LIMIT_VOTE_WINDOW,
        keyGenerator: (req) => `ratelimit:vote:${req.body.userId}`
    }),
    async (req: express.Request, res: express.Response) => {
        try {
            const { bvid, userId }: { bvid?: string; userId?: string } = req.body;

            // 1. 基础参数校验
            if (!bvid || !userId) return res.status(400).json({ success: false, error: 'Missing params' });

            const isMember: number = await executeUnvoteScript(String(bvid), String(userId));
            if (!isMember) return res.status(400).json({ error: 'Not voted yet' });
            res.json({ success: true });
        } catch (error: any) {
            console.error('Vote Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
);

// 获取状态
app.get(['/api/status', '/status'], async (req: express.Request, res: express.Response) => {
    const { bvid, userId }: { bvid?: string; userId?: string } = req.query;
    try {
        const [isVoted, totalCount]: [number, string | null] = await executeStatusScript(String(bvid), String(userId));
        res.json({ success: true, active: !!isVoted, count: Number(totalCount) || 0 });
    } catch (error: any) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取排行榜
app.get(['/api/leaderboard', '/leaderboard'],
    createRateLimitMiddleware({
        max: RATE_LIMIT_LEADERBOARD_MAX,
        window: RATE_LIMIT_LEADERBOARD_WINDOW,
        keyGenerator: (req) => {
            const clientIP: string = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || '';
            return `ratelimit:leaderboard:${clientIP}`;
        }
    }),
    async (req: express.Request, res: express.Response) => {
        const { range = 'realtime' }: { range?: string } = req.query;
        if (range !== 'realtime' && range !== 'daily' && range !== 'weekly' && range !== 'monthly') {
            return res.status(400).json({ success: false, error: 'Invalid range' });
        }

        try {
            const board: { bvid: string; count: number }[] | null = await getLeaderBoard(range);
            if (!board) {
                return res.json({ success: false, list: [] });
            }
            res.json({ success: true, list: board });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
);

// app.listen(3000);
export default app;
