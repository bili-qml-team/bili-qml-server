import express from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

const JWT_SECRET: string = process.env.JWT_SECRET || 'change-it-in-producation';
const JWT_ALG: string = 'HS256';
const TOKEN_TTL_SECONDS: number = 30 * 24 * 60 * 60;
const CHALLENGE_LENGTH: number = 8;

type JwtPayload = {
    uid: string;
    exp: number;
};

function base64UrlEncode(input: Buffer | string): string {
    const buffer: Buffer = typeof input === 'string' ? Buffer.from(input) : input;
    return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
    const base64: string = input.replace(/-/g, '+').replace(/_/g, '/');
    const padded: string = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return Buffer.from(padded, 'base64');
}

function createChallengeName(userId: string): string {
    if (!JWT_SECRET) {
        throw new Error('JWT secret missing');
    }
    const digest: string = createHmac('sha256', JWT_SECRET).update(userId).digest('hex');
    const chunk: string = digest.slice(0, 10);
    const value: bigint = BigInt(`0x${chunk}`);
    const base36: string = value.toString(36);
    return base36.padStart(CHALLENGE_LENGTH, '0').slice(0, CHALLENGE_LENGTH);
}

function signJwt(payload: JwtPayload): string {
    if (!JWT_SECRET) {
        throw new Error('JWT secret missing');
    }
    const header: { alg: string; typ: string } = { alg: JWT_ALG, typ: 'JWT' };
    const safePayload: JwtPayload = { uid: String(payload.uid), exp: payload.exp };
    const headerPart: string = base64UrlEncode(JSON.stringify(header));
    const payloadPart: string = base64UrlEncode(JSON.stringify(safePayload));
    const signingInput: string = `${headerPart}.${payloadPart}`;
    const signature: Buffer = createHmac('sha256', JWT_SECRET).update(signingInput).digest();
    const signaturePart: string = base64UrlEncode(signature);
    return `${signingInput}.${signaturePart}`;
}

function verifyJwt(token: string): JwtPayload | null {
    if (!JWT_SECRET) {
        return null;
    }
    const parts: string[] = token.split('.');
    if (parts.length !== 3) {
        return null;
    }
    const [headerPart, payloadPart, signaturePart] = parts;
    let header: { alg?: string } | null = null;
    let payload: { uid?: string | number; exp?: number } | null = null;
    try {
        header = JSON.parse(base64UrlDecode(headerPart).toString('utf8'));
        payload = JSON.parse(base64UrlDecode(payloadPart).toString('utf8'));
    } catch {
        return null;
    }
    if (!header || header.alg !== JWT_ALG) {
        return null;
    }
    if (!payload || typeof payload.exp !== 'number' || (!payload.uid && payload.uid !== 0)) {
        return null;
    }
    const payloadKeys: string[] = Object.keys(payload);
    if (payloadKeys.some((key) => key !== 'uid' && key !== 'exp')) {
        return null;
    }
    const signingInput: string = `${headerPart}.${payloadPart}`;
    const expectedSignature: Buffer = createHmac('sha256', JWT_SECRET).update(signingInput).digest();
    const signature: Buffer = base64UrlDecode(signaturePart);
    if (signature.length !== expectedSignature.length) {
        return null;
    }
    if (!timingSafeEqual(signature, expectedSignature)) {
        return null;
    }
    const now: number = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
        return null;
    }
    return { uid: String(payload.uid), exp: payload.exp };
}

function createTokenFavNameHandler(): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        try {
            const { userId }: { userId?: string } = req.body;
            if (!userId) {
                return res.status(400).json({ success: false, error: 'Missing params' });
            }
            const name: string = createChallengeName(userId);
            return res.json({ success: true, name });
        } catch (error: any) {
            console.error('Token Name Error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    };
}

function createTokenVerifyHandler(): express.RequestHandler {
    return async (req: express.Request, res: express.Response) => {
        try {
            const { userId, mediaId }: { userId?: string; mediaId?: string } = req.body;
            if (!userId || !mediaId) {
                return res.status(400).json({ success: false, error: 'Missing params' });
            }
            if (!JWT_SECRET) {
                return res.status(500).json({ success: false, error: 'JWT secret missing' });
            }
            const expectedName: string = createChallengeName(userId);
            const headers: Record<string, string> = {
                "Accept": "*/*",
                "Accept-Encoding": "gzip, deflate, br",
                "Accept-Language": "zh-CN,zh;q=0.9,en-CN;q=0.8,en;q=0.7",
                "Origin": "https://www.bilibili.com",
                "Referer": "https://www.bilibili.com",
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
            };
            const response: Response = await fetch(`https://api.bilibili.com/x/v3/fav/folder/info?media_id=${encodeURIComponent(mediaId)}`,
                {
                    method: 'GET',
                    headers
                }
            );
            if (!response.ok) {
                return res.status(502).json({ success: false, error: 'Bili API Error' });
            }
            const payload: any = await response.json();
            if (!payload || payload.code !== 0 || !payload.data) {
                return res.status(400).json({ success: false, error: payload?.message || 'Invalid response' });
            }
            const data: any = payload.data;
            if (String(data.mid) !== String(userId)) {
                return res.status(403).json({ success: false, error: 'User ID mismatch' });
            }
            if (data.title !== expectedName) {
                return res.status(403).json({ success: false, error: 'Invalid challenge name' });
            }
            const attrValue: number = data.attr
            const isPrivate = typeof attrValue === 'number' ? (attrValue & 1) === 1 : undefined;
            if (isPrivate) {
                return res.status(403).json({ success: false, error: 'Private folder' });
            }
            const now: number = Math.floor(Date.now() / 1000);
            if (data.ctime < now - 15 * 60) {
                return res.status(403).json({ success: false, error: 'Challenge expired' });
            }
            const token: string = signJwt({ uid: String(userId), exp: now + TOKEN_TTL_SECONDS });
            return res.json({ success: true, token });
        } catch (error: any) {
            console.error('Token Verify Error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    };
}

function createJwtAuthMiddleware(): express.RequestHandler {
    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
        try {
            const authHeader: string = req.headers.authorization || '';
            const match: RegExpMatchArray | null = authHeader.match(/^Bearer\s+(.+)$/i);
            if (!match) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            const payload: JwtPayload | null = verifyJwt(match[1].trim());
            if (!payload) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            const { userId }: { userId?: string } = req.body;
            if (!userId) {
                return res.status(400).json({ success: false, error: 'Missing params' });
            }
            if (String(userId) !== String(payload.uid)) {
                return res.status(403).json({ success: false, error: 'User ID mismatch' });
            }
            res.locals.jwtUid = payload.uid;
            return next();
        } catch (error: any) {
            console.error('JWT Auth Error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    };
}

export {
    createTokenFavNameHandler,
    createTokenVerifyHandler,
    createJwtAuthMiddleware
};
