if (process.env.UPSTASH_REDIS_REST_URL) {
    console.log(`UPSTASH_REDIS_REST_URL is set: ${process.env.UPSTASH_REDIS_REST_URL}`);
} else {
    console.log('UPSTASH_REDIS_REST_URL is not set.');
}