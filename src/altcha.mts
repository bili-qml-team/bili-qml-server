import { Redis } from "ioredis";
import express from "express";
import { createChallenge, verifySolution } from "altcha-lib";
import type { Challenge } from "altcha-lib/types";

// Altcha 配置
const ALTCHA_HMAC_KEY: string = process.env.ALTCHA_HMAC_KEY || 'bili-qml-default-hmac-key-change-in-production';
const ALTCHA_COMPLEXITY: number = Number(process.env.ALTCHA_COMPLEXITY) || 1000000; // PoW 难度

async function checkRateLimit(redis: Redis, key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
    // 使用 Lua 脚本确保原子性：第一次时设置过期，之后就不再更新
    const lua = `
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then
            redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
        end
        return current
    `;
    const current = await redis.eval(lua, 1, key, windowSeconds) as number;
    return current > maxRequests;
}

// 重置频率限制（CAPTCHA 验证通过后）
async function resetRateLimit(redis: Redis, key: string): Promise<void> {
    await redis.del(key);
}

// Rate Limit 中间件工厂函数
interface RateLimitOptions {
    max: number;
    window: number;
    keyGenerator: (req: express.Request) => string;
}

function createRateLimitMiddleware(redis: Redis, options: RateLimitOptions): express.RequestHandler {
    return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            const key: string = options.keyGenerator(req);
            const isRateLimited: boolean = await checkRateLimit(redis, key, options.max, options.window);
            // 存储到 res.locals 供后续处理器使用
            res.locals.rateLimitKey = key;
            res.locals.isRateLimited = isRateLimited;

            // 如果未被限制，直接放行
            if (!isRateLimited) {
                return next();
            }
            // return res.status(429).json({ success: false, error: '你太快了！或者，你可能不是人类？' });

            // 如果被限制，检查是否有 CAPTCHA 解决方案
            const altcha: string | undefined = req.body?.altcha || req.query?.altcha as string | undefined;

            if (altcha) {
                const isValid: boolean = await verifySolution(altcha, ALTCHA_HMAC_KEY);
                if (!isValid) {
                    return res.status(400).json({ success: false, error: 'Invalid CAPTCHA', requiresCaptcha: true });
                }
                // CAPTCHA 验证通过，重置频率限制
                await resetRateLimit(redis, key);
                return next();
            }

            // 没有 CAPTCHA，要求客户端完成验证
            return res.status(429).json({ success: false, error: '你太快了！或者，你可能不是人类？', requiresCaptcha: true });
        } catch (error: any) {
            console.error('Rate Limit Middleware Error:', error);
            return res.status(500).json({ success: false, error: 'Rate limit check failed' });
        }
    };
}

function createCaptchaChallengeHandler(): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
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
        };
    }
}

export {
    createRateLimitMiddleware,
    createCaptchaChallengeHandler
};