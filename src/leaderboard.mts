import { Redis } from 'ioredis';
import express from 'express';

const TIMESTAMP_EXPIRE_MS: number = Number(process.env.TIMESTAMP_EXPIRE_MS) || 180 * 24 * 3600 * 1000; //排行榜总数据过期时间
const leaderboardTimeInterval: number[] = [12 * 3600 * 1000, 24 * 3600 * 1000, 7 * 24 * 3600 * 1000, 30 * 24 * 3600 * 1000]; //排行榜相差时间
const PAGE_SIZE: number = 30;
const MAX_PAGES: number = 10;

// const leaderboardLuaScript = `
// local votes = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2])
// local counts = {}
// local videos = {}

// for _, v in ipairs(votes) do
//     local parts = {}
//     for part in string.gmatch(v, "[^:]+") do
//         table.insert(parts, part)
//     end
//     local bvid = parts[1]
    
//     if counts[bvid] == nil then
//         counts[bvid] = 0
//         table.insert(videos, bvid)
//     end
//     counts[bvid] = counts[bvid] + 1
// end

// table.sort(videos, function(a, b)
//     return counts[a] > counts[b]
// end)

// local limit = tonumber(ARGV[3])
// local result = {}
// for i = 1, math.min(#videos, limit) do
//     table.insert(result, videos[i])
//     table.insert(result, counts[videos[i]])
// end
// return result
// `;
const leaderboardScript = `local votes = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2])\nlocal counts = {}\nlocal videos = {}\nfor _, v in ipairs(votes) do\n    local parts = {}\n    for part in string.gmatch(v, "[^:]+") do\n        table.insert(parts, part)\n    end\n    local bvid = parts[1]\n    \n    if counts[bvid] == nil then\n        counts[bvid] = 0\n        table.insert(videos, bvid)\n    end\n    counts[bvid] = counts[bvid] + 1\nend\ntable.sort(videos, function(a, b)\n    return counts[a] > counts[b]\nend)\nlocal limit = tonumber(ARGV[3])\nlocal result = {}\nfor i = 1, math.min(#videos, limit) do\n    table.insert(result, videos[i])\n    table.insert(result, counts[videos[i]])\nend\nreturn result`;
const leaderboardScriptSha: string = "becc0d589f7b2611dd0c6d3b45c111628d763105";

async function executeLeaderboardScript(redis: Redis, minTime: number, maxTime: number, limit: number): Promise<(string | number)[]> {
    try {
        return await redis.evalsha(leaderboardScriptSha, 1, 'votes:recent', minTime, maxTime, limit) as Promise<(string | number)[]>;
    } catch {
        // 脚本丢失
        try {
            await redis.script("LOAD", leaderboardScript);
            return await redis.evalsha(leaderboardScriptSha, 1, 'votes:recent', minTime, maxTime, limit) as Promise<(string | number)[]>;
        } catch (err: any) {
            err.message = `Load Script Error: ${err.message}, check script sha values.`;
            throw err;
        }
    }
}

async function getLeaderBoardFromTime(redis: Redis, periodMs: number, limit: number = PAGE_SIZE * MAX_PAGES): Promise<{ bvid: string, count: number }[]> {
    const now: number = Date.now();
    const minTime: number = now - periodMs;

    try {
        // 先清理过期数据
        await redis.zremrangebyscore('votes:recent', '-inf', now - TIMESTAMP_EXPIRE_MS - 1);

        const result: (string | number)[] = await executeLeaderboardScript(redis, minTime, now, limit);

        const leaderboard: { bvid: string, count: number }[] = [];
        for (let i = 0; i < result.length; i += 2) {
            leaderboard.push({
                bvid: result[i] as string,
                count: result[i + 1] as number
            });
        }
        return leaderboard;
    } catch (error) {
        console.error('Error in getLeaderBoardFromTime with Lua:', error);
        return [];
    }
}

async function getLeaderBoard(redis: Redis, range: string, page: number): Promise<{ bvid: string, count: number }[] | null> {
    try {
        const cacheKey = `${range}:${page}`;
        const response: string | null = await redis.hget('caches:leaderboard:pages', cacheKey);
        if (!response) {
            return null;
        }
        return JSON.parse(response);
    } catch (error) {
        console.error(`Error fetching leaderboard page for ${range}:${page}:`, error);
        return null;
    }
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

            // 分页缓存到Redis，每页30条
            const ranges = ['realtime', 'daily', 'weekly', 'monthly'];
            const pipelineCommands: Array<[string, ...any[]]> = [];

            // 先清空旧的分页缓存，避免残留旧页
            await redis.del('caches:leaderboard:pages');

            for (let i = 0; i < ranges.length; i++) {
                const rangeData = leaderBoardCaches[i];
                for (let page = 1; page <= MAX_PAGES; page++) {
                    const start = (page - 1) * PAGE_SIZE;
                    const end = start + PAGE_SIZE;
                    const pageData = rangeData.slice(start, end);
                    pipelineCommands.push(['hset', 'caches:leaderboard:pages', `${ranges[i]}:${page}`, JSON.stringify(pageData)]);
                }
            }

            if (pipelineCommands.length > 0) {
                const pipeline = redis.pipeline();
                pipelineCommands.forEach(cmd => pipeline.call(...cmd));
                await pipeline.exec();
            }
            console.log('Leaderboard cache updated.');

            return res.json({ success: true });
        } catch (error: any) {
            console.error('Leaderboard Cache Update Error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    };
}

function createGetLeaderBoardHandler(redis: Redis): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        const { range = 'realtime', page = '1' }: { range?: string, page?: string } = req.query;
        const paramPage: number = Number(page);
        if (range !== 'realtime' && range !== 'daily' && range !== 'weekly' && range !== 'monthly') {
            return res.status(400).json({ success: false, error: 'Invalid range' });
        }
        if (isNaN(paramPage) || paramPage < 1 || paramPage > MAX_PAGES) {
            return res.status(400).json({ success: false, error: 'Invalid page number' });
        }
        try {
            const board: { bvid: string; count: number }[] | null = await getLeaderBoard(redis, range, paramPage);
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