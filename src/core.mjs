import { initAltcha , altchaCheck } from './altcha.mjs';
import {leaderBoard,setupRefreshFromNetwork} from './leaderboard.mjs';
const leaderboardTimeInterval = [12 * 3600 * 1000,24 * 3600 * 1000, 7 * 24 * 3600 * 1000, 30 * 24 * 3600 * 1000]; //排行榜相差时间

async function fetchTitle(list){
    return Promise.all(list.map(async (item, index) => {
        try {
            const conn = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${item.bvid}`,
                {
                headers: {
                    "Origin": "https://www.bilibili.com",
                    "Referer": `https://www.bilibili.com/video/${item.bvid}/`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3',
                    }
                });
            const json = await conn.json();
            if (json.code === 0 && json.data?.title) {
                list[index].title = json.data.title;
            } else {
                list[index].title = '未知标题';
            }
        } catch (err) {
            console.error(`获取标题失败 ${item.bvid}:`, err);
            list[index].title = '加载失败';
        }
    }));
}

function initCoreApi(redis,app){

    initAltcha(redis,app);
    this.leaderboard=new leaderBoard(redis,leaderboardTimeInterval)
    setupRefreshFromNetwork(this.leaderboard,app)

    // 处理投票
    app.post(['/api/vote', '/vote'], async (req, res) => {
        try {
            const { bvid, userId, altcha } = req.body;
            if (!bvid || !userId) return res.status(400).json({ success: false, error: 'Missing params' });
            const rateLimitKey = `ratelimit:vote:${userId}`;
            await altchaCheck(altcha,rateLimitKey,res);
            const voted = await redis.sadd(`voted:${bvid}`, userId); // 3. 用户投票记录
            if (voted === 0) return res.status(400).json({ success: false, error: 'Already Voted' });
            const now = Date.now(); // 排行榜时间戳记录
            await Promise.all([
                redis.hincrby(`video:${bvid}`, 'votesTotal', 1),
                redis.zadd('votes:recent', now, `${bvid}:${userId}`)
            ]);
            res.json({ success: true });
        } catch (error) {
            console.error('Vote Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post(['/api/unvote', '/unvote'], async (req, res) => {
        try {
            const { bvid, userId, altcha } = req.body;
            if (!bvid || !userId) return res.status(400).json({ success: false, error: 'Missing params' });
            const rateLimitKey = `ratelimit:vote:${userId}`;
            await altchaCheck(altcha,rateLimitKey,res)
            const isMember = await redis.sismember(`voted:${bvid}`, userId);
            if (!isMember) return res.status(400).json({ error: 'Not voted yet' });
            await Promise.all([
                redis.srem(`voted:${bvid}`, userId),           // 删除投票记录
                redis.zrem('votes:recent', `${bvid}:${userId}`), // 删除排行榜记录
                redis.hincrby(`video:${bvid}`, 'votesTotal', -1)
            ]);
            res.json({ success: true });
        } catch (error) {
            console.error('Vote Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取状态
    app.get(['/api/status', '/status'], async (req, res) => {
        const { bvid, userId } = req.query;
        try {
            const [isVoted, totalCount] = await Promise.all([
                redis.sismember(`voted:${bvid}`, userId),
                redis.hget(`video:${bvid}`, 'votesTotal')
            ]);
            res.json({ success: true, active: !!isVoted, count: totalCount });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取排行榜
    app.get(['/api/leaderboard', '/leaderboard'], async (req, res) => {
        const { range = 'realtime', type, altcha } = req.query;
        let proc_type = parseInt(type);

        try {
            // 使用 IP 作为频率限制标识（排行榜是公开的，不需要 userId）
            const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
            const rateLimitKey = `ratelimit:leaderboard:${clientIP}`;
            await altchaCheck(altcha,rateLimitKey)

            const board = await this.leaderboard.getLeaderBoard(range);
            if (range !== 'realtime') res.set('QML-Cache-Expires', `${leaderBoardCache.expireTime}`);
            let list = board.map((array) => { return { bvid: array[0], count: array[1] } });
            // no type or type != 2: add backward capability
            if (!proc_type || proc_type !== 2) {
                await fetchTitle(list);
            }
            res.json({ success: true, list: list });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });
}
export {
    initCoreApi
}
