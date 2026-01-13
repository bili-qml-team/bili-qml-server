import {fakeMap_Alltrue as fakeMap,fixedRing} from './utils.mjs';

class cacheManager{
    mapList=[]; //external access
    baseTime=0;
    lastUpdate=0;
    timeSlice=0;
    constructor(redis, leaderboardTimeInterval){
        this.redis= redis;
        this.leaderboardTimeInterval= [0, ...leaderboardTimeInterval];
        this.cacheCount=this.leaderboardTimeInterval.length;
        this.mapList=[...Array(this.cacheCount-1).keys()].map((index)=>{return new Map();});
        this.fakemap=new fakeMap;
    }
    async fetchRange(index,slice = this.timeSlice){
        return await this.redis.zrangebyscore('votes:recent', this.baseTime - this.leaderboardTimeInterval[index] - slice,this.baseTime - this.leaderboardTimeInterval[index]);
        // now(head) -> lastupdate
    }
    async update(){
        this.baseTime=Date.now();
        this.timeSlice = this.baseTime-this.lastUpdate;
        this.lastUpdate = this.baseTime;
        let Votes=await Promise.all([...Array(this.cacheCount).keys()].map(async (index)=>{return this.fetchRange(index)}));
        this.mapList.forEach((item,index)=>{
            for (const member of Votes[index]) {
                const bvid = member.split(':')[0];
                item.set(bvid,(item.get(bvid) || 0) + 1);
            }
            for (const member of Votes[index+1]) {
                const bvid = member.split(':')[0];
                item.set(bvid,(item.get(bvid) || 0) - 1);
            }
        });
    }
    async init(){
        this.baseTime=Date.now()
        this.lastUpdate = this.baseTime;
        await this.updateSingle([...Array(this.cacheCount-1).keys()]);
    }
    async updateSingle(index){
        index=Array.isArray(index) ? index : [index];
        let Votes=await Promise.all(index.map(async (index)=>{return this.fetchRange(index,this.leaderboardTimeInterval[index+1]-this.leaderboardTimeInterval[index])}));
        index.forEach((index)=>{
            this.mapList[index].clear();
            for (const member of Votes[index]) {
                const bvid = member.split(':')[0];
                this.mapList[index].set(bvid,(this.mapList[index].get(bvid) || 0) + 1);
            }
        });
    }
    expireVotes(index,threshold){
        this.mapList[index].forEach((value,key)=>{
            if(!value || (value<threshold && !(this.mapList[index-1] || this.fakemap).get(key))){
                this.mapList[index].delete(key);
            }
        });
    }
    getSingle(inde,limit = 30,guessMax = NaN){
        function inInverseCDF(p){ //# 前p的概率对应排名下限
            return Math.pow(p, 1/-0.76); //幂率猜测 从需要的比例反向推算(\frac{X}{X_{min}}) 20260113 月榜测得PDF幂常数 -1.76
        }
        function CDF(n){
            return Math.pow(n,-0.76);
        }
        function computeCacheSize(index){
                let CDFMax=inInverseCDF(1/(this.mapList[index].size)); //仿射CDF的最大值
                let ratio=guessMax/CDFMax; //与猜测的比例
                let guessRank=inInverseCDF(limit/(this.mapList[index].size));
                let deltaRank=1/ratio; //线性变换 实际差值->CDF仿射空间 相差1
                let range=CDF(guessRank)-CDF(guessRank+deltaRank); //猜测的第limit个视频需要的数量的比例
                let cacheSize=Math.ceil(this.mapList[index].size*range) || limit; //若没有传入guessMax则默认limit
                return cacheSize;
        }
        let maps=[];
            for(let index=inde-2;index>=0;index--){
                maps[index+1]=new Map();
                let cacheSize=computeCacheSize(index+1);
                this.mapList[index+1].forEach((count,bvid) => {
                    if(!maps[index+1].has(count)){
                        maps[index+1].set(count,new fixedRing(cacheSize)); //点赞量->bv
                    }
                    maps[index+1].get(count).push(bvid);
                });
                maps[index+1].keys().forEach((value) => {maps[index+1].set(value,maps[index+1].get(value).ring)});
            }
            maps[0]=new Map();
            this.mapList[0].forEach((count,bvid)=>{
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
}
export{
    cacheManager
}
