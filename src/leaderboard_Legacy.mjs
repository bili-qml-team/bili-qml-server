const TIMESTAMP_EXPIRE_MS = Number(process.env.TIMESTAMP_EXPIRE_MS) || 180 * 24 * 3600 * 1000; //排行榜总数据过期时间
const CACHE_EXPIRE_MS = Number(process.env.CACHE_EXPIRE_MS) || 300 * 1000; // 排行榜cache过期时间

class cacheManager{
    redis=undefined;
    leaderBoardCache={
    expireTime:0,
    caches:[]
    }
    constructor(redis,leaderboardTimeInterval){
        this.redis=redis
        this.leaderboardTimeInterval=leaderboardTimeInterval;
    }
    async getLeaderBoardFromTime(periodMs = 24 * 3600 * 1000, limit = 30) {
    const now = Date.now();
    const minTime = now - periodMs;
    const counts = {};
    const [_, recentVotes] = await Promise.all([
        this.redis.zremrangebyscore('votes:recent', '-inf', now - TIMESTAMP_EXPIRE_MS - 1),
        this.redis.zrangebyscore('votes:recent', minTime, now)
    ]);
    for (const member of recentVotes) {
        const bvid = member.split(':')[0];  // 从 `${bvid}:${userId}` 提取
        counts[bvid] = (counts[bvid] || 0) + 1;
    }
    const sorted = Object.entries(counts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit);
    return sorted;
    }
    async init(){
        this.update();
    }
    async update() {
        this.leaderBoardCache.expireTime = Date.now() + CACHE_EXPIRE_MS; // break
        this.leaderBoardCache.caches = await Promise.all(this.leaderboardTimeInterval.map((time) => {
        return this.getLeaderBoardFromTime(time);
    }));
    }
    getSingle(index){
        return leaderBoardCache[index];
    }
    async updateSingle(index){
        this.leaderBoardCache.caches[index]=await this.getLeaderBoardFromTime(this.leaderboardTimeInterval[index]);
    }
}
export{
    cacheManager
}
