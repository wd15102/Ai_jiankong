@echo off
cd /d "%~dp0"

echo ==============================================
echo   发送公众号引导消息
echo ==============================================
echo.

node -e "
const fs = require('fs');
const https = require('https');

const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
let followers = {};
try {
    followers = JSON.parse(fs.readFileSync('data/followers.json', 'utf8'));
} catch(e) {
    console.log('读取 followers.json 失败');
    process.exit(1);
}

console.log('关注者数量:', Object.keys(followers).length);
console.log('');

const getToken = () => new Promise((resolve) => {
    https.get('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' + config.wxTest.appId + '&secret=' + config.wxTest.appSecret, {rejectUnauthorized: false}, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', e => resolve({error: e.message}));
});

const sendMsg = (token, openid, content) => new Promise((resolve) => {
    const postData = JSON.stringify({touser: openid, msgtype: 'text', text: {content}});
    const options = {hostname: 'api.weixin.qq.com', port: 443, path: '/cgi-bin/message/custom/send?access_token=' + token, method: 'POST', rejectUnauthorized: false, headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData)}};
    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', e => resolve({error: e.message}));
    req.write(postData);
    req.end();
});

(async () => {
    const tokenResult = await getToken();
    if (!tokenResult.access_token) {
        console.log('Token 获取失败:', tokenResult.error);
        return;
    }
    
    const message = '? 老家监控已上线！\n\n发送关键词查看画面：\n「看家」= 双溪村\n「门口」= 木山村\n「今日有人」= 今天活动记录\n「状态」= 系统状态';
    
    let ok = 0, fail = 0;
    for (const [openid, name] of Object.entries(followers)) {
        const r = await sendMsg(tokenResult.access_token, openid, message);
        if (r.errcode === 0) {
            ok++;
            console.log('? 发送给: ' + (name || openid));
        } else {
            fail++;
            console.log('? 发送给 ' + (name || openid) + ': ' + r.errmsg);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    
    console.log('');
    console.log('=====================================');
    console.log('发送完成: 成功 ' + ok + ' 人, 失败 ' + fail + ' 人');
    console.log('=====================================');
})();
"

pause
