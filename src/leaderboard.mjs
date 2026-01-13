import {cacheManager} from './leaderboard_Legacy.mjs'

class leaderBoard{
    constructor(redis,leaderboardTimeInterval){
        this.cache=new cacheManager(redis,leaderboardTimeInterval);
        this.cache.init();
    }
    async getLeaderBoard(range) {
    switch (range) {
        case "realtime":
            await this.cache.updateSingle(0);
            return this.cache.getSingle(0); //实时榜单 过去12小时
        case "daily":
            return this.cache.getSingle(1);
        case "weekly":
            return this.cache.getSingle(2);
        case "monthly":
            return this.cache.getSingle(3);
    }
    }
    getFullRange(){
        return [...Array(this.cache.leaderboardTimeInterval.length).keys()].map((index)=>{return leaderboard.cache.getSingle(index)});
    }

}



function setupRefreshFromNetwork(leaderboard,app){
    // EdgeOne Pages不支持定时任务自动刷新，提供手动刷新接口，由外部定时任务调用
    app.use(["/api/refresh", "/refresh"], async (req, res) => {
        const authHeader = req.headers["authorization"];
        const token = authHeader && authHeader.split(" ")[1];
        // simple token check
        if (!token || token !== process.env.REFRESH_TOKEN) {
            return res.status(403).json({ message: "Token missing" });
        }
        try {
            await leaderboard.cache.update();
            return res.json({ success: true, leaderBoardCache:leaderboard.getFullRange() });
        } catch (error) {
            console.error('Leaderboard Cache Update Error:', error);
            return res.status(500).json({ success: false, error: 'Failed to refresh cache' });
        }
    });
}
export{
    leaderBoard,
    setupRefreshFromNetwork
}
