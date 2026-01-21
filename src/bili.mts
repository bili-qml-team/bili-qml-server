import { Redis } from 'ioredis';
import express from 'express';


function createGetViewHandler(): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        try {
            const bvid: string = req.query.bvid as string;
            if (!bvid) {
                res.status(400).json({ success: false, error: 'Missing bvid parameter' });
                return;
            }
            const response: Response = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
                {
                    method: 'GET',
                    headers: {
                        "Accept": "*/*",
                        "Accept-Encoding": "gzip, deflate, br",
                        "Accept-Language": "zh-CN,zh;q=0.9,en-CN;q=0.8,en;q=0.7",
                        "Origin": "https://www.bilibili.com",
                        "Referer": `https://www.bilibili.com/video/${bvid}`,
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
                    }
                }
            );
            res.json(await response.json());
        } catch (error: any) {
            console.error('Get View Error:', error);
            res.status(500).json({ success: false, error: error.message });
            return;
        }
    }
}

export {
    createGetViewHandler
};