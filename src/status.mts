import { Redis } from 'ioredis';
import express from 'express';

// Redis Lua 脚本预加载
const statusScriptLua: string = `return {redis.call('sismember', KEYS[1], ARGV[1]), redis.call('hget', KEYS[2], ARGV[2])}`;
const statusScriptSha: string = "f0c6a6a82f3fa5cd22bb667e27c5ba1b1fcdbd33";

async function executeStatusScript(redis: Redis, bvid: string, userId: string): Promise<[number, string | null]> {
    try {
        return await redis.evalsha(statusScriptSha, 2, `voted:${bvid}`, `video:${bvid}`, userId || '', 'votesTotal') as Promise<[number, string | null]>;
    } catch {
        // 脚本丢失
        try {
            await redis.script("LOAD", statusScriptLua);
            return await redis.evalsha(statusScriptSha, 2, `voted:${bvid}`, `video:${bvid}`, userId || '', 'votesTotal') as Promise<[number, string | null]>;
        } catch (err: any) {
            err.message = `Load Script Error: ${err.message}, check script sha values.`;
            throw err;
        }

    }
}

function createGetStatusHandler(redis: Redis): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        const { bvid, userId }: { bvid?: string; userId?: string } = req.query;
        try {
            const [isVoted, totalCount]: [number, string | null] = await executeStatusScript(redis, String(bvid), String(userId));
            res.json({ success: true, active: !!isVoted, count: Number(totalCount) || 0 });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message });
        }
    }
}

export {
    createGetStatusHandler
};