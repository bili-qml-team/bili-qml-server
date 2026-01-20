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

/**
 * 中转 B站 archive 图片的 handler
 * URL 格式: /api/bfs/archive/:path 或 /bfs/archive/:path
 * 会代理请求到 https://i0.hdslb.com/bfs/archive/{path}
 */
function createArchiveImageProxyHandler(): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        try {
            const path: string = req.params.path as string;
            if (!path) {
                res.status(400).json({ success: false, error: 'Missing path parameter' });
                return;
            }

            // 验证 path 格式，防止路径注入攻击
            // 允许的格式：字母数字、下划线、点、斜杠，以常见图片后缀结尾
            if (!/^[a-zA-Z0-9_\-\/\.]+\.(jpg|jpeg|png|gif|webp)$/i.test(path)) {
                res.status(400).json({ success: false, error: 'Invalid path format' });
                return;
            }

            const targetUrl: string = `https://i0.hdslb.com/bfs/archive/${path}`;
            const response: Response = await fetch(targetUrl, {
                method: 'GET',
                headers: {
                    "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
                    "Accept-Encoding": "gzip, deflate, br",
                    "Accept-Language": "zh-CN,zh;q=0.9,en-CN;q=0.8,en;q=0.7",
                    "Referer": "https://www.bilibili.com/",
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
                }
            });

            if (!response.ok) {
                res.status(response.status).json({ success: false, error: `Upstream returned ${response.status}` });
                return;
            }

            // 设置响应头
            const contentType: string | null = response.headers.get('content-type');
            if (contentType) {
                res.set('Content-Type', contentType);
            }

            // 允许浏览器缓存图片
            res.set('Cache-Control', 'public, max-age=86400'); // 缓存24小时

            // 返回图片数据
            const buffer: ArrayBuffer = await response.arrayBuffer();
            res.send(Buffer.from(buffer));
        } catch (error: any) {
            console.error('Archive Image Proxy Error:', error);
            res.status(500).json({ success: false, error: error.message });
            return;
        }
    }
}

export {
    createGetViewHandler,
    createArchiveImageProxyHandler
};