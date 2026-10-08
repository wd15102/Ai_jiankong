const {createPublicGate}=require("../lib/publicgate");
function lb(r){var a=r.socket&&r.socket.remoteAddress;return a==="127.0.0.1"||a==="::1"||a==="::ffff:127.0.0.1";}
var G=createPublicGate({wxServer:{publicToken:"T"}},lb),G2=createPublicGate({wxServer:{}},lb);
function res(){return{code:0,headers:{},setHeader:function(k,v){this.headers[k]=v;},writeHead:function(c){this.code=c;},end:function(){}};}
function q(a,m,c){return{socket:{remoteAddress:a},method:m||"GET",headers:c?{host:"127.0.0.1:8787",cookie:c}:{host:"127.0.0.1:8787"}};}
function u(s){return new URL(s,"http://x");}
var f=0,n=0;
function t(name,r,url,exp,g){var R=res();var b=(g||G).publicGate(r,u(url),R);n++;var ok=b===exp;if(!ok)f++;console.log((ok?"PASS ":"FAIL ")+name+" blocked="+b+" code="+R.code+(R.headers["Set-Cookie"]?" cookie=set":""));}
t("live-no-token",q("1.2.3.4"),"/live?serial=X",true);
t("captures-no-token",q("1.2.3.4"),"/captures/a.jpg",true);
t("ptz-no-token",q("1.2.3.4"),"/api/ptz?serial=X&dir=up",true);
t("detail-no-token",q("1.2.3.4"),"/detail?file=a.jpg",true);
t("history-no-token",q("1.2.3.4"),"/history",true);
t("token-ok",q("1.2.3.4"),"/live?token=T",false);
t("token-bad",q("1.2.3.4"),"/live?token=X",true);
t("cookie-ok",q("1.2.3.4","GET","kj=T"),"/captures/a.jpg",false);
t("cookie-bad",q("1.2.3.4","GET","kj=X"),"/captures/a.jpg",true);
t("cookie-mixed",q("1.2.3.4","GET","a=1; kj=T; b=2"),"/captures/a.jpg",false);
t("loopback",q("127.0.0.1"),"/captures/a.jpg",false);
t("ezviz-post",q("1.2.3.4","POST"),"/ezviz/push",false);
t("wechat-post",q("1.2.3.4","POST"),"/",false);
t("signature-get",q("1.2.3.4"),"/?signature=a",false);
t("no-config",q("1.2.3.4"),"/captures/a.jpg",false,G2);
function qt(h,a){return{socket:{remoteAddress:a||"127.0.0.1"},method:"GET",headers:{host:h}};}t("tunnel-host-blocks",qt("51875aa38ez9.vicp.fun"),"/captures/a.jpg",true);t("tunnel-who-blocks",qt("51875aa38ez9.vicp.fun"),"/__who",true);t("tunnel-shutdown-blocks",qt("51875aa38ez9.vicp.fun"),"/__shutdown?pid=1",true);t("tunnel-live-blocks",qt("51875aa38ez9.vicp.fun"),"/live?serial=X",true);t("tunnel-health-ok",qt("51875aa38ez9.vicp.fun"),"/health",false);t("tunnel-root-ok",qt("51875aa38ez9.vicp.fun"),"/?signature=x",false);n++;var tu=G.tokUrl("http://d.com/t?serial=X");if(tu!=="http://d.com/t?serial=X&token=T"){f++;console.log("FAIL tokUrl "+tu);}else{console.log("PASS tokUrl "+tu);}
console.log("结果: "+(n-f)+" 通过 / "+f+" 失败 (共 "+n+")");
process.exit(f?1:0);
