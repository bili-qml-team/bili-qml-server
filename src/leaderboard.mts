import { Redis } from 'ioredis';
import express from 'express';

const TIMESTAMP_EXPIRE_MS: number = Number(process.env.TIMESTAMP_EXPIRE_MS) || 180 * 24 * 3600 * 1000; //排行榜总数据过期时间
const leaderboardTimeInterval: number[] = [12 * 3600 * 1000, 24 * 3600 * 1000, 7 * 24 * 3600 * 1000, 30 * 24 * 3600 * 1000]; //排行榜相差时间

async function getLeaderBoardFromTime(redis: Redis, periodMs: number = 24 * 3600 * 1000, limit: number = 30): Promise<{ bvid: string, count: number }[]> {
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

async function getCachedLeaderBoard(redis: Redis, range: string): Promise<{ bvid: string, count: number }[] | null> {
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

async function getLeaderBoard(redis: Redis, range: string): Promise<{ bvid: string, count: number }[] | null> {
    return await getCachedLeaderBoard(redis, range);
}

function createRefreshLeaderBoardHandler(redis: Redis): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        const authHeader: string | undefined = req.headers["authorization"];
        const token: string | undefined = authHeader && authHeader.split(" ")[1];
        // simple token check
        if (!token || token !== process.env.REFRESH_TOKEN) {
            return res.status(403).json({ success: false, error: "Token missing" });
        }
        try {
            const leaderBoardCaches: { bvid: string, count: number }[][] = await Promise.all(leaderboardTimeInterval.map((time) => {
                return getLeaderBoardFromTime(redis, time);
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
    };
}

function createGetLeaderBoardHandler(redis: Redis): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        const { range = 'realtime' }: { range?: string } = req.query;
        if (range !== 'realtime' && range !== 'daily' && range !== 'weekly' && range !== 'monthly') {
            return res.status(400).json({ success: false, error: 'Invalid range' });
        }

        try {
            const board: { bvid: string; count: number }[] | null = await getLeaderBoard(redis, range);
            if (!board) {
                return res.json({ success: false, list: [] });
            }
            res.json({ success: true, list: board });
        } catch (error: any) {
            res.status(500).json({ success: false, error: error.message });
        }
    };
}

export {
    createGetLeaderBoardHandler,
    createRefreshLeaderBoardHandler
};