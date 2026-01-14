import fs from 'fs/promises';
import path from 'path';

async function getClientCert(filename) {
    let response = await fetch(`https://api.github.com/repos/bili-qml-team/qml-server-cert/contents/client/${filename}`,
        {
            headers: {
                'Accept': 'application/vnd.github.raw+json',
                'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                'User-Agent': 'Bili-QML-Server 1.2'
            }
        });
    return await response.text();
}


const clientCerts = {
    key: await getClientCert('redis-client.key'),
    cert: await getClientCert('redis-client.crt')
}

const serverFilePath = path.resolve('src/server.mts');
let serverFileContent = await fs.readFile(serverFilePath, 'utf-8');
serverFileContent = serverFileContent.replace('${process.env.REDIS_TLS_KEY}', clientCerts.key);
serverFileContent = serverFileContent.replace('${process.env.REDIS_TLS_CERT}', clientCerts.cert);
await fs.writeFile(serverFilePath, serverFileContent, 'utf-8');
