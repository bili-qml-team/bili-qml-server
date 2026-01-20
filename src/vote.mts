import { Redis } from 'ioredis';
import express from 'express';

// Redis Lua 脚本预加载
const voteScriptLua: string = `local voted = redis.call('sadd', KEYS[1], ARGV[1])\nif voted == 1 then\n    redis.call('hincrby', KEYS[2], ARGV[2], 1)\n    redis.call('zadd', KEYS[3], ARGV[3], ARGV[4])\nend\nreturn voted`;
const voteScriptSha: string = "fdd1c85ca528240976fa7af8fcce32536eadc271";

const unvoteScriptLua: string = `local isMember = redis.call('sismember', KEYS[1], ARGV[1])\nif isMember == 1 then\n    redis.call('srem', KEYS[1], ARGV[1])\n    redis.call('zrem', KEYS[2], ARGV[2])\n    redis.call('hincrby', KEYS[3], ARGV[3], -1)\nend\nreturn isMember`;
const unvoteScriptSha: string = "8c7c993d5352c20a6d0d270d862cc50c00a6cacd";

async function executeVoteScript(redis: Redis, bvid: string, userId: string, timestamp: number): Promise<number> {
    try {
        return await redis.evalsha(voteScriptSha, 3, `voted:${bvid}`, `video:${bvid}`, 'votes:recent', userId, 'votesTotal', timestamp, `${bvid}:${userId}`) as Promise<number>;
    } catch {
        try {
            await redis.script("LOAD", voteScriptLua);
            return await redis.evalsha(voteScriptSha, 3, `voted:${bvid}`, `video:${bvid}`, 'votes:recent', userId, 'votesTotal', timestamp, `${bvid}:${userId}`) as Promise<number>;
        } catch (err: any) {
            err.message = `Load Script Error: ${err.message}, check script sha values.`;
            throw err;
        }
    }
}

async function executeUnvoteScript(redis: Redis, bvid: string, userId: string): Promise<number> {
    try {
        return await redis.evalsha(unvoteScriptSha, 3, `voted:${bvid}`, 'votes:recent', `video:${bvid}`, userId, `${bvid}:${userId}`, 'votesTotal') as Promise<number>;
    } catch {
        try {
            await redis.script("LOAD", unvoteScriptLua);
            return await redis.evalsha(unvoteScriptSha, 3, `voted:${bvid}`, 'votes:recent', `video:${bvid}`, userId, `${bvid}:${userId}`, 'votesTotal') as Promise<number>;
        } catch (err: any) {
            err.message = `Load Script Error: ${err.message}, check script sha values.`;
            throw err;
        }
    }
}

function createPostVoteHandler(redis: Redis): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        try {
            const { bvid, userId }: { bvid?: string; userId?: string } = req.body;

            // 1. 基础参数校验
            if (!bvid || !userId) return res.status(400).json({ success: false, error: 'Missing params' });

            // 2. 用户投票记录（使用 Lua 脚本原子操作）
            const now: number = Date.now();
            const voted: number = await executeVoteScript(redis, String(bvid), String(userId), now);
            if (voted === 0) return res.status(400).json({ success: false, error: 'Already Voted' });
            res.json({ success: true });
        } catch (error: any) {
            console.error('Vote Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
}

function createPostUnvoteHandler(redis: Redis): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        try {
            const { bvid, userId }: { bvid?: string; userId?: string } = req.body;

            // 1. 基础参数校验
            if (!bvid || !userId) return res.status(400).json({ success: false, error: 'Missing params' });

            const isMember: number = await executeUnvoteScript(redis, String(bvid), String(userId));
            if (!isMember) return res.status(400).json({ error: 'Not voted yet' });
            res.json({ success: true });
        } catch (error: any) {
            console.error('Vote Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }
}

export {
    createPostVoteHandler,
    createPostUnvoteHandler
};