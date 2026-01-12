import {cacheManager,fixedRing} from './utils.mjs';

const TIMESTAMP_EXPIRE_MS = Number(process.env.TIMESTAMP_EXPIRE_MS) || 180 * 24 * 3600 * 1000; //排行榜总数据过期时间
const CACHE_EXPIRE_MS = Number(process.env.CACHE_EXPIRE_MS) || 300 * 1000; // 排行榜cache过期时间
const leaderboardTimeInterval = [12 * 3600 * 1000,24 * 3600 * 1000, 7 * 24 * 3600 * 1000, 30 * 24 * 3600 * 1000]; //排行榜相差时间

let redis=undefined;
let leaderBoardCache={
    expireTime:0,
    caches:[]
}
let bucketCache=undefined;
async function getLeaderBoardFromTime(periodMs = 24 * 3600 * 1000, limit = 30) {
    const now = Date.now();
    const minTime = now - periodMs;
    const counts = {};
    const [_, recentVotes] = await Promise.all([
        redis.zremrangebyscore('votes:recent', '-inf', now - TIMESTAMP_EXPIRE_MS - 1),
        redis.zrangebyscore('votes:recent', minTime, now)
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

function getLeaderBoardFromBucketIndex(inde,limit = 30,guessMax = NaN){
    function inInverseCDF(p){ //# 前p的概率对应排名下限
        return Math.pow(p, 1/-0.76); //幂率猜测 从需要的比例反向推算(\frac{X}{X_{min}}) 20260113 月榜测得PDF幂常数 -1.76
    }
    function CDF(n){
        return Math.pow(n,-0.76);
    }
    let maps=[];
    for(let index=inde-2;index>=0;index--){
        maps[index+1]=new Map();
        let CDFMax=inInverseCDF(1/(bucketCache.mapList[index+1].size)); //仿射CDF的最大值
        let ratio=guessMax/CDFMax; //与猜测的比例
        let guessRank=inInverseCDF(limit/(bucketCache.mapList[index+1].size));
        let deltaRank=1/ratio; //线性变换 实际差值->CDF仿射空间 相差1
        let range=CDF(guessRank)-CDF(guessRank+deltaRank); //猜测的第limit个视频需要的数量的比例
        let cacheSize=Math.ceil(bucketCache.mapList[index+1].size*range) || limit; //若没有传入guessMax则默认limit
        bucketCache.mapList[index+1].forEach((count,bvid) => {
            if(!maps[index+1].has(count)){
                maps[index+1].set(count,new fixedRing(cacheSize)); //点赞量->bv
            }
            maps[index+1].get(count).push(bvid);
        });
        maps[index+1].keys().forEach((value) => {maps[index+1].set(value,maps[index+1].get(value).ring)});
    }
    maps[0]=new Map();
    bucketCache.mapList[0].forEach((count,bvid)=>{
        if(!maps[0].has(count)){
                maps[0].set(count,[]);
            }
            maps[0].get(count).push(bvid); //点赞量->bv
    });
    let result={};
    maps.forEach((map)=>{map.forEach((bvidList,count)=>{
        bvidList.forEach((bvid)=>{
            result[bvid]=(result[bvid] || 0) + Number(count); // bv->点赞量
        })
    })});
    const sorted = Object.entries(result)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit);
    return sorted;
}

async function getLeaderBoard(range) {
    switch (range) { //滑动窗口榜单 以UNIX时间戳计算
        case "realtime":
            return await getLeaderBoardFromBucketIndex(0); //实时榜单 过去12小时
        case "daily":
            return leaderBoardCache.caches[0];
        case "weekly":
            return leaderBoardCache.caches[1];
        case "monthly":
            return leaderBoardCache.caches[2];
    }
}

async function updateLeaderBoardCache() {
    leaderBoardCache.expireTime = Date.now() + CACHE_EXPIRE_MS;
    await cacheManager.update();
    leaderBoardCache.caches = await Promise.all([1,2,3].map((time) => {
        return getLeaderBoardFromBucketIndex(time);
    }));
    console.log('Leaderboard cache updated.');
}
async function initLeaderboardManager(paraRedis){
    redis=paraRedis;
    bucketCache=new cacheManager(redis,leaderboardTimeInterval);
    await bucketCache.init();
}
export{
    initLeaderboardManager,
    getLeaderBoard
}
