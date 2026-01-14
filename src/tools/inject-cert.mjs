import fs from 'fs/promises';
import path from 'path';

async function getClientCert(filename) {
    let response = await fetch(`https://api.github.com/repos/bili-qml-team/qml-server-cert/contents/${filename}`,
        {
            headers: {
                'Accept': 'application/vnd.github.raw+json',
                'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                'User-Agent': 'Bili-QML-Server 1.2'
            }
        });
    return await response.text();
}


const [key, cert, cacert] = await Promise.all([
    getClientCert('redis.key'),
    getClientCert('redis.crt'),
    getClientCert('ca.crt')
]);

const serverFilePath = path.resolve('src/server.mts');
let serverFileContent = await fs.readFile(serverFilePath, 'utf-8');
serverFileContent = serverFileContent.replace('${process.env.REDIS_TLS_KEY}', key);
serverFileContent = serverFileContent.replace('${process.env.REDIS_TLS_CERT}', cert);
serverFileContent = serverFileContent.replace('${process.env.REDIS_TLS_CACERT}', cacert);
await fs.writeFile(serverFilePath, serverFileContent, 'utf-8');
